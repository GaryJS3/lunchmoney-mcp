import { open, realpath } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
    api,
    dataResponse,
    successResponse,
    handleApiError,
    catchError,
    errorResponse,
} from "../api.js";

const ALLOWED_ATTACHMENT_MIME_TYPES = [
    "image/jpeg",
    "image/png",
    "image/heic",
    "image/heif",
    "application/pdf",
] as const;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// Enough to cover the longest signature we check: the ISO-BMFF `ftyp` box
// header plus its major brand occupies the first 12 bytes.
const ATTACHMENT_HEADER_BYTES = 16;
const PNG_SIGNATURE = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
// ISO-BMFF major brands. HEIC and HEIF share a container; the brand decides
// which of the two MIME types the LunchMoney API expects.
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx"]);
const HEIF_BRANDS = new Set(["mif1", "msf1", "heim", "heis", "hevm", "hevs"]);

const splitChildSchema = z.object({
    amount: z.coerce
        .number()
        .describe(
            "Amount of this split. Sum of all children must equal the parent's amount.",
        ),
    payee: z
        .string()
        .max(140)
        .optional()
        .describe("Defaults to the parent's payee."),
    date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
        .optional()
        .describe("Defaults to the parent's date."),
    category_id: z.coerce
        .number()
        .optional()
        .describe(
            "Category ID. Defaults to parent's category. Cannot be a category group.",
        ),
    tag_ids: z.array(z.coerce.number()).optional(),
    notes: z
        .string()
        .max(350)
        .optional()
        .describe("Defaults to the parent's notes."),
});

const dateString = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format");
const dateOrDateTimeString = z
    .string()
    .describe(
        "Date (YYYY-MM-DD) or ISO 8601 datetime (e.g. 2025-06-25T17:00:04Z).",
    );
const statusEnum = z.enum(["reviewed", "unreviewed", "delete_pending"]);
const writeStatusEnum = z.enum(["reviewed", "unreviewed"]);

const insertTransactionSchema = z.object({
    date: dateString.describe("Date in YYYY-MM-DD format."),
    amount: z.coerce
        .number()
        .describe(
            "Numeric value (no currency symbol). Positive = debit, negative = credit. Up to 4 decimal places.",
        ),
    currency: z
        .string()
        .length(3)
        .optional()
        .describe(
            "Three-letter lowercase currency code (defaults to primary currency).",
        ),
    payee: z.string().max(140).optional().describe("Payee name."),
    original_name: z.string().max(140).nullable().optional(),
    category_id: z.coerce.number().nullable().optional(),
    notes: z.string().max(350).nullable().optional(),
    manual_account_id: z.coerce
        .number()
        .nullable()
        .optional()
        .describe(
            "Manual account ID. Mutually exclusive with plaid_account_id.",
        ),
    plaid_account_id: z.coerce
        .number()
        .nullable()
        .optional()
        .describe(
            "Plaid account ID. Mutually exclusive with manual_account_id.",
        ),
    recurring_id: z.coerce.number().nullable().optional(),
    status: writeStatusEnum.optional(),
    tag_ids: z.array(z.coerce.number()).optional(),
    external_id: z.string().max(75).nullable().optional(),
    custom_metadata: z.record(z.unknown()).nullable().optional(),
});

const updateTransactionFieldsSchema = z.object({
    date: dateString.optional(),
    amount: z.coerce.number().optional(),
    currency: z.string().length(3).optional(),
    payee: z.string().max(140).optional(),
    category_id: z.coerce.number().nullable().optional(),
    notes: z.string().max(350).nullable().optional(),
    manual_account_id: z.coerce.number().nullable().optional(),
    plaid_account_id: z.coerce.number().nullable().optional(),
    recurring_id: z.coerce.number().nullable().optional(),
    status: writeStatusEnum.optional(),
    tag_ids: z
        .array(z.coerce.number())
        .optional()
        .describe(
            "Replaces all existing tags on the transaction. Mutually exclusive with additional_tag_ids.",
        ),
    additional_tag_ids: z
        .array(z.coerce.number())
        .optional()
        .describe(
            "Adds these tags to the existing transaction tags. Mutually exclusive with tag_ids.",
        ),
    external_id: z.string().max(75).nullable().optional(),
    custom_metadata: z.record(z.unknown()).nullable().optional(),
});

export function registerTransactionTools(server: McpServer) {
    server.registerTool(
        "get_transactions",
        {
            description:
                "Retrieve transactions, optionally filtered by date range, account, category, tag, recurring item, status, and more. Returns at most `limit` transactions (default 1000, max 2000); `has_more` is set on the response when more match the filters. Pending and split-parent / group-child transactions are excluded by default.",
            inputSchema: {
                start_date: dateString
                    .optional()
                    .describe(
                        "Beginning of the date range. Required if end_date is set.",
                    ),
                end_date: dateString
                    .optional()
                    .describe(
                        "End of the date range. Required if start_date is set.",
                    ),
                created_since: dateOrDateTimeString
                    .optional()
                    .describe(
                        "Only return transactions created after this timestamp.",
                    ),
                updated_since: dateOrDateTimeString
                    .optional()
                    .describe(
                        "Only return transactions updated after this timestamp.",
                    ),
                manual_account_id: z.coerce
                    .number()
                    .optional()
                    .describe(
                        "Filter by manual account ID, or 0 to omit all manual-account transactions.",
                    ),
                plaid_account_id: z.coerce
                    .number()
                    .optional()
                    .describe(
                        "Filter by Plaid account ID, or 0 to omit all Plaid-account transactions.",
                    ),
                recurring_id: z.coerce.number().optional(),
                category_id: z.coerce
                    .number()
                    .optional()
                    .describe(
                        "Filter by category ID. 0 returns only un-categorized transactions. Matches both leaf categories and category groups.",
                    ),
                tag_id: z.coerce.number().optional(),
                is_group_parent: z
                    .boolean()
                    .optional()
                    .describe(
                        "If true, returns only transaction groups (group parents).",
                    ),
                status: statusEnum.optional(),
                is_pending: z
                    .boolean()
                    .optional()
                    .describe(
                        "Filter by pending status. Takes precedence over include_pending when set.",
                    ),
                include_pending: z
                    .boolean()
                    .optional()
                    .describe(
                        "Include imported pending transactions in results.",
                    ),
                include_metadata: z
                    .boolean()
                    .optional()
                    .describe(
                        "Include plaid_metadata and custom_metadata fields on each transaction.",
                    ),
                include_split_parents: z
                    .boolean()
                    .optional()
                    .describe(
                        "Include the original parent transactions of split transactions.",
                    ),
                include_group_children: z
                    .boolean()
                    .optional()
                    .describe(
                        "Include the original transactions that were combined into transaction groups.",
                    ),
                include_children: z
                    .boolean()
                    .optional()
                    .describe(
                        "Populate the `children` array on group/split parent transactions.",
                    ),
                include_files: z
                    .boolean()
                    .optional()
                    .describe(
                        "Include the `files` array (attachment metadata) on each transaction.",
                    ),
                limit: z.coerce
                    .number()
                    .min(1)
                    .max(2000)
                    .optional()
                    .describe(
                        "Max transactions to return (1-2000, default 1000).",
                    ),
                offset: z.coerce
                    .number()
                    .optional()
                    .describe(
                        "Offset for pagination. Use with `has_more` from a previous response.",
                    ),
            },
            annotations: {
                readOnlyHint: true,
            },
        },
        async (input) => {
            try {
                const params = new URLSearchParams();
                for (const [key, value] of Object.entries(input)) {
                    if (value === undefined || value === null) continue;
                    params.append(key, String(value));
                }

                const qs = params.toString();
                const response = await api.get(
                    `/transactions${qs ? `?${qs}` : ""}`,
                );

                if (!response.ok) {
                    return handleApiError(
                        response,
                        "Failed to get transactions",
                    );
                }

                return dataResponse(await response.json());
            } catch (error) {
                return catchError(error, "Failed to get transactions");
            }
        },
    );

    server.registerTool(
        "get_single_transaction",
        {
            description:
                "Get details of a specific transaction. The response always includes plaid_metadata, custom_metadata, files, and (for split or group parents) the children array — none of which are returned by default in get_transactions.",
            inputSchema: {
                transaction_id: z.coerce
                    .number()
                    .describe("ID of the transaction to retrieve."),
            },
            annotations: {
                readOnlyHint: true,
            },
        },
        async ({ transaction_id }) => {
            try {
                const response = await api.get(
                    `/transactions/${transaction_id}`,
                );

                if (!response.ok) {
                    return handleApiError(
                        response,
                        "Failed to get transaction",
                    );
                }

                return dataResponse(await response.json());
            } catch (error) {
                return catchError(error, "Failed to get transaction");
            }
        },
    );

    server.registerTool(
        "create_transactions",
        {
            description:
                "Insert one or more transactions (1-500 per call). Returns inserted transactions plus any skipped duplicates.",
            inputSchema: {
                transactions: z
                    .array(insertTransactionSchema)
                    .min(1)
                    .max(500)
                    .describe("Array of transactions to insert (1-500)."),
                apply_rules: z
                    .boolean()
                    .optional()
                    .describe(
                        "Apply rules associated with the transaction's manual_account_id.",
                    ),
                skip_duplicates: z
                    .boolean()
                    .optional()
                    .describe(
                        "Flag transactions that match an existing transaction's date+payee+amount+account as duplicates and skip them. Note: external_id deduplication always runs regardless of this flag.",
                    ),
                skip_balance_update: z
                    .boolean()
                    .optional()
                    .describe(
                        "If true, do not update the manual account's balance when inserting these transactions.",
                    ),
            },
            annotations: {
                idempotentHint: false,
            },
        },
        async ({
            transactions,
            apply_rules,
            skip_duplicates,
            skip_balance_update,
        }) => {
            try {
                const body: Record<string, unknown> = { transactions };
                if (apply_rules !== undefined) body.apply_rules = apply_rules;
                if (skip_duplicates !== undefined)
                    body.skip_duplicates = skip_duplicates;
                if (skip_balance_update !== undefined)
                    body.skip_balance_update = skip_balance_update;

                const response = await api.post("/transactions", body);

                if (!response.ok) {
                    return handleApiError(
                        response,
                        "Failed to create transactions",
                    );
                }

                return dataResponse(await response.json());
            } catch (error) {
                return catchError(error, "Failed to create transactions");
            }
        },
    );

    server.registerTool(
        "update_transaction",
        {
            description:
                "Update an existing transaction. Provide any subset of writable fields directly (the v2 API no longer wraps the body in a `transaction` envelope). Cannot modify split or grouped transactions; use the corresponding split/group tools instead.",
            inputSchema: {
                transaction_id: z.coerce
                    .number()
                    .describe("ID of the transaction to update."),
                update: updateTransactionFieldsSchema.describe(
                    "Fields to update. Provide at least one writable field.",
                ),
                update_balance: z
                    .boolean()
                    .optional()
                    .describe(
                        "Defaults to true. Pass false to skip updating the associated manual account's balance.",
                    ),
            },
            annotations: {
                idempotentHint: true,
            },
        },
        async ({ transaction_id, update, update_balance }) => {
            try {
                const path =
                    update_balance === undefined
                        ? `/transactions/${transaction_id}`
                        : `/transactions/${transaction_id}?update_balance=${update_balance}`;
                const response = await api.put(path, update);

                if (!response.ok) {
                    return handleApiError(
                        response,
                        "Failed to update transaction",
                    );
                }

                return dataResponse(await response.json());
            } catch (error) {
                return catchError(error, "Failed to update transaction");
            }
        },
    );

    server.registerTool(
        "delete_transaction",
        {
            description:
                "Delete a single transaction. Fails for split/group transactions and their parents — unsplit/ungroup first. Irreversible.",
            inputSchema: {
                transaction_id: z.coerce
                    .number()
                    .describe("ID of the transaction to delete."),
            },
            annotations: {
                destructiveHint: true,
            },
        },
        async ({ transaction_id }) => {
            try {
                const response = await api.delete(
                    `/transactions/${transaction_id}`,
                );

                if (response.status === 204) {
                    return successResponse("Transaction deleted.");
                }

                if (!response.ok) {
                    return handleApiError(
                        response,
                        "Failed to delete transaction",
                    );
                }

                return dataResponse(await response.json());
            } catch (error) {
                return catchError(error, "Failed to delete transaction");
            }
        },
    );

    server.registerTool(
        "update_transactions_bulk",
        {
            description:
                "Update multiple transactions in a single call (1-500). Each entry must include `id` plus at least one writable field. Cannot be used to modify split or grouped transactions.",
            inputSchema: {
                transactions: z
                    .array(
                        updateTransactionFieldsSchema.extend({
                            id: z.coerce
                                .number()
                                .describe(
                                    "ID of the transaction to update (required).",
                                ),
                        }),
                    )
                    .min(1)
                    .max(500)
                    .describe(
                        "Array of partial transaction updates, each keyed by its `id`.",
                    ),
            },
            annotations: {
                idempotentHint: true,
            },
        },
        async ({ transactions }) => {
            try {
                const response = await api.put("/transactions", {
                    transactions,
                });

                if (!response.ok) {
                    return handleApiError(
                        response,
                        "Failed to bulk update transactions",
                    );
                }

                return dataResponse(await response.json());
            } catch (error) {
                return catchError(error, "Failed to bulk update transactions");
            }
        },
    );

    server.registerTool(
        "delete_transactions_bulk",
        {
            description:
                "Bulk-delete transactions by ID (1-500). Fails if any ID is a split or group parent, or part of a split/group; unsplit or ungroup those first. Irreversible.",
            inputSchema: {
                ids: z
                    .array(z.coerce.number())
                    .min(1)
                    .max(500)
                    .describe("Array of transaction IDs to delete (1-500)."),
            },
            annotations: {
                destructiveHint: true,
            },
        },
        async ({ ids }) => {
            try {
                const response = await api.delete("/transactions", { ids });

                if (response.status === 204) {
                    return successResponse(
                        `Deleted ${ids.length} transaction(s).`,
                    );
                }

                if (!response.ok) {
                    return handleApiError(
                        response,
                        "Failed to bulk delete transactions",
                    );
                }

                return dataResponse(await response.json());
            } catch (error) {
                return catchError(error, "Failed to bulk delete transactions");
            }
        },
    );

    server.registerTool(
        "create_transaction_group",
        {
            description:
                "Create a transaction group from 2-500 existing transactions. Source transactions are hidden from get_transactions and accessible via the new group's `children` (set include_children=true on get_single_transaction). Cannot include split or recurring transactions.",
            inputSchema: {
                ids: z
                    .array(z.coerce.number())
                    .min(2)
                    .max(500)
                    .describe(
                        "IDs of existing transactions to group together.",
                    ),
                date: dateString.describe(
                    "Date for the new grouped transaction (YYYY-MM-DD).",
                ),
                payee: z
                    .string()
                    .max(140)
                    .describe("Payee for the new grouped transaction."),
                category_id: z.coerce
                    .number()
                    .nullable()
                    .optional()
                    .describe(
                        "Category for the group. If unset and all children share a category, the group inherits it.",
                    ),
                notes: z.string().max(350).nullable().optional(),
                status: writeStatusEnum
                    .optional()
                    .describe(
                        "Status for the new grouped transaction. Defaults to reviewed.",
                    ),
                tag_ids: z
                    .array(z.coerce.number())
                    .optional()
                    .describe("Tag IDs to apply to the new group."),
            },
            annotations: {
                idempotentHint: false,
            },
        },
        async (input) => {
            try {
                const body: Record<string, unknown> = {};
                for (const [key, value] of Object.entries(input)) {
                    if (value === undefined) continue;
                    body[key] = value;
                }

                const response = await api.post("/transactions/group", body);

                if (!response.ok) {
                    return handleApiError(
                        response,
                        "Failed to create transaction group",
                    );
                }

                return dataResponse(await response.json());
            } catch (error) {
                return catchError(error, "Failed to create transaction group");
            }
        },
    );

    server.registerTool(
        "delete_transaction_group",
        {
            description:
                "Delete (ungroup) a transaction group. The original child transactions remain and revert to normal ungrouped transactions.",
            inputSchema: {
                transaction_id: z.coerce
                    .number()
                    .describe(
                        "ID of the transaction group (the group parent transaction) to delete.",
                    ),
            },
            annotations: {
                destructiveHint: true,
            },
        },
        async ({ transaction_id }) => {
            try {
                const response = await api.delete(
                    `/transactions/group/${transaction_id}`,
                );

                if (response.status === 204) {
                    return successResponse("Transaction group ungrouped.");
                }

                if (!response.ok) {
                    return handleApiError(
                        response,
                        "Failed to delete transaction group",
                    );
                }

                return successResponse("Transaction group ungrouped.");
            } catch (error) {
                return catchError(error, "Failed to delete transaction group");
            }
        },
    );

    server.registerTool(
        "split_transaction",
        {
            description:
                "Split an existing transaction into 2-500 child transactions. The sum of child amounts must equal the parent's amount. After splitting, the parent is hidden from get_transactions and accessible via get_single_transaction (returns the parent with `children`).",
            inputSchema: {
                transaction_id: z.coerce
                    .number()
                    .describe("ID of the transaction to split."),
                child_transactions: z
                    .array(splitChildSchema)
                    .min(2)
                    .max(500)
                    .describe(
                        "Children to create. Sum of amounts must equal the parent's amount.",
                    ),
            },
            annotations: {
                idempotentHint: false,
            },
        },
        async ({ transaction_id, child_transactions }) => {
            try {
                const response = await api.post(
                    `/transactions/split/${transaction_id}`,
                    { child_transactions },
                );

                if (!response.ok) {
                    return handleApiError(
                        response,
                        "Failed to split transaction",
                    );
                }

                return dataResponse(await response.json());
            } catch (error) {
                return catchError(error, "Failed to split transaction");
            }
        },
    );

    server.registerTool(
        "unsplit_transaction",
        {
            description:
                "Unsplit a previously split transaction by deleting its children and restoring the parent. Pass the parent (split_parent_id) — not a child — as the path id.",
            inputSchema: {
                transaction_id: z.coerce
                    .number()
                    .describe(
                        "ID of the previously split parent transaction. Use the split_parent_id of a split child to find it.",
                    ),
            },
            annotations: {
                destructiveHint: true,
            },
        },
        async ({ transaction_id }) => {
            try {
                const response = await api.delete(
                    `/transactions/split/${transaction_id}`,
                );

                if (response.status === 204) {
                    return successResponse("Transaction unsplit.");
                }

                if (!response.ok) {
                    return handleApiError(
                        response,
                        "Failed to unsplit transaction",
                    );
                }

                return successResponse("Transaction unsplit.");
            } catch (error) {
                return catchError(error, "Failed to unsplit transaction");
            }
        },
    );

    server.registerTool(
        "attach_file_to_transaction",
        {
            description:
                "Attach a local image or PDF receipt (max 10MB) to a transaction. Allowed types: image/jpeg, image/png, image/heic, image/heif, application/pdf. The file is read from the local filesystem of the host running this MCP server, and its type is determined from its actual contents — files that are not a real image or PDF are rejected. If LUNCHMONEY_ATTACHMENTS_DIR is set on the host, only files inside that directory can be attached.",
            inputSchema: {
                transaction_id: z.coerce
                    .number()
                    .describe("ID of the transaction to attach the file to."),
                file_path: z
                    .string()
                    .describe(
                        "Absolute or relative path to the receipt file on the local filesystem. Must be a regular file whose contents are a JPEG, PNG, HEIC, HEIF, or PDF. If the host sets LUNCHMONEY_ATTACHMENTS_DIR, the path must resolve inside that directory.",
                    ),
                content_type: z
                    .enum(ALLOWED_ATTACHMENT_MIME_TYPES)
                    .optional()
                    .describe(
                        "Optional assertion of the file's MIME type. The server always determines the real type from the file contents; if this disagrees with it, the request is rejected. Omit unless you need that check.",
                    ),
                notes: z
                    .string()
                    .optional()
                    .describe("Optional notes describing the attachment."),
            },
            annotations: {
                idempotentHint: false,
            },
        },
        async ({ transaction_id, file_path, content_type, notes }) => {
            try {
                const file = await readAttachment(file_path);
                if (!file.ok) {
                    return errorResponse(
                        `Failed to attach file to transaction: ${file.message}`,
                    );
                }

                // The caller may assert a type, but the file's own bytes are
                // authoritative. A mismatch means the caller is confused about
                // what it is uploading, so refuse rather than silently
                // correcting it.
                if (content_type !== undefined && content_type !== file.mime) {
                    return errorResponse(
                        `Failed to attach file to transaction: declared content_type ${content_type} does not match the file's actual type ${file.mime}.`,
                    );
                }

                const blob = new Blob([new Uint8Array(file.data)], {
                    type: file.mime,
                });

                const formData = new FormData();
                formData.append("file", blob, basename(file_path));
                if (notes !== undefined) formData.append("notes", notes);

                const response = await api.upload(
                    `/transactions/${transaction_id}/attachments`,
                    formData,
                );

                if (!response.ok) {
                    return handleApiError(
                        response,
                        "Failed to attach file to transaction",
                    );
                }

                return dataResponse(await response.json());
            } catch (error) {
                return catchError(
                    error,
                    "Failed to attach file to transaction",
                );
            }
        },
    );

    server.registerTool(
        "get_transaction_attachment_url",
        {
            description:
                "Get a short-lived signed download URL for a transaction file attachment. The response includes the URL and an `expires_at` timestamp.",
            inputSchema: {
                file_id: z.coerce
                    .number()
                    .describe("ID of the file attachment."),
            },
            annotations: {
                readOnlyHint: true,
            },
        },
        async ({ file_id }) => {
            try {
                const response = await api.get(
                    `/transactions/attachments/${file_id}`,
                );

                if (!response.ok) {
                    return handleApiError(
                        response,
                        "Failed to get attachment URL",
                    );
                }

                return dataResponse(await response.json());
            } catch (error) {
                return catchError(error, "Failed to get attachment URL");
            }
        },
    );

    server.registerTool(
        "delete_transaction_attachment",
        {
            description: "Delete a transaction file attachment. Irreversible.",
            inputSchema: {
                file_id: z.coerce
                    .number()
                    .describe("ID of the file attachment to delete."),
            },
            annotations: {
                destructiveHint: true,
            },
        },
        async ({ file_id }) => {
            try {
                const response = await api.delete(
                    `/transactions/attachments/${file_id}`,
                );

                if (response.status === 204) {
                    return successResponse("Attachment deleted.");
                }

                if (!response.ok) {
                    return handleApiError(
                        response,
                        "Failed to delete attachment",
                    );
                }

                return successResponse("Attachment deleted.");
            } catch (error) {
                return catchError(error, "Failed to delete attachment");
            }
        },
    );
}

/**
 * Identify an attachment by its leading bytes.
 *
 * The file extension and any caller-supplied MIME type are both untrusted —
 * only the contents decide. Returns `null` for anything that is not one of the
 * types the LunchMoney attachments endpoint accepts, which is what stops this
 * tool from being used to read arbitrary non-media files off the host.
 */
function sniffMimeType(header: Buffer): string | null {
    if (
        header.length >= 3 &&
        header[0] === 0xff &&
        header[1] === 0xd8 &&
        header[2] === 0xff
    ) {
        return "image/jpeg";
    }
    if (header.length >= 8 && header.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return "image/png";
    }
    if (
        header.length >= 5 &&
        header.subarray(0, 5).toString("latin1") === "%PDF-"
    ) {
        return "application/pdf";
    }
    if (
        header.length >= 12 &&
        header.subarray(4, 8).toString("latin1") === "ftyp"
    ) {
        const brand = header.subarray(8, 12).toString("latin1");
        if (HEIC_BRANDS.has(brand)) return "image/heic";
        if (HEIF_BRANDS.has(brand)) return "image/heif";
    }
    return null;
}

type AttachmentRead =
    | { ok: true; data: Buffer; mime: string }
    | { ok: false; message: string };

/**
 * Read a file the caller named, for upload as a transaction attachment.
 *
 * `file_path` reaches this server from an AI model, which may in turn be acting
 * on untrusted content (a payee name, a note, a web page). Treat it as hostile:
 *
 * 1. If `LUNCHMONEY_ATTACHMENTS_DIR` is set, the path must resolve inside it.
 *    The check runs after `realpath`, so `..` traversal and symlink escapes are
 *    both caught. Unset means unconfined — fine for a desktop stdio server,
 *    where the caller and the file owner are the same person, but deployments
 *    that expose this server over HTTP should always set it.
 * 2. Only regular files, so `/dev/*` and FIFOs can't be opened.
 * 3. Size is checked from `stat` before any bytes are buffered, so a huge file
 *    can't exhaust memory on its way to being rejected.
 * 4. The type comes from the leading bytes, checked before the rest of the file
 *    is read. Credentials, keys, and `.env` files never make it into memory.
 *
 * Filesystem errors are logged to stderr but reported back to the caller
 * generically — distinguishing ENOENT from EACCES would let a caller map out
 * the host's filesystem one failed call at a time.
 */
async function readAttachment(filePath: string): Promise<AttachmentRead> {
    const unreadable = {
        ok: false as const,
        message: "file could not be read.",
    };
    const root = process.env.LUNCHMONEY_ATTACHMENTS_DIR;

    let resolved: string;
    try {
        resolved = await realpath(resolve(filePath));
    } catch (error) {
        console.error(`Failed to resolve attachment path: ${describe(error)}`);
        return unreadable;
    }

    if (root) {
        let base: string;
        try {
            base = await realpath(resolve(root));
        } catch (error) {
            console.error(
                `Failed to resolve LUNCHMONEY_ATTACHMENTS_DIR: ${describe(error)}`,
            );
            return {
                ok: false,
                message: `the directory configured in LUNCHMONEY_ATTACHMENTS_DIR (${root}) could not be resolved.`,
            };
        }
        if (resolved !== base && !resolved.startsWith(base + sep)) {
            return {
                ok: false,
                message:
                    "file_path resolves outside the directory configured in LUNCHMONEY_ATTACHMENTS_DIR.",
            };
        }
    }

    let handle;
    try {
        handle = await open(resolved, "r");
    } catch (error) {
        console.error(`Failed to open attachment: ${describe(error)}`);
        return unreadable;
    }

    try {
        const stats = await handle.stat();
        if (!stats.isFile()) {
            return {
                ok: false,
                message: "file_path must point to a regular file.",
            };
        }
        if (stats.size > MAX_ATTACHMENT_BYTES) {
            return {
                ok: false,
                message: `file size ${stats.size} bytes exceeds maximum of ${MAX_ATTACHMENT_BYTES} bytes (10MB).`,
            };
        }

        // Reading at an explicit position leaves the handle's own offset at 0,
        // so the readFile() below still returns the whole file.
        const header = Buffer.alloc(ATTACHMENT_HEADER_BYTES);
        const { bytesRead } = await handle.read(
            header,
            0,
            ATTACHMENT_HEADER_BYTES,
            0,
        );
        const mime = sniffMimeType(header.subarray(0, bytesRead));
        if (!mime) {
            return {
                ok: false,
                message: `the file's contents are not a supported attachment type. Allowed types are: ${ALLOWED_ATTACHMENT_MIME_TYPES.join(", ")}`,
            };
        }

        return { ok: true, data: await handle.readFile(), mime };
    } catch (error) {
        console.error(`Failed to read attachment: ${describe(error)}`);
        return unreadable;
    } finally {
        await handle.close().catch(() => {});
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
