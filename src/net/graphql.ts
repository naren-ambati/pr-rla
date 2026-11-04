/**
 * What a GraphQL request body asks for, for the read-only guard (contracts.md §2
 * step 2) and the rate governor's point cost.
 *
 * A small tokenizer, not a regex over the raw body: it skips strings, block
 * strings and comments, and reads the keyword that opens each top-level
 * definition. Only `query`, `fragment` and the `{ … }` shorthand are reads.
 * Anything it cannot read counts as not a read, so the guard fails closed.
 */

export type OperationKind = "query" | "mutation" | "subscription" | "fragment" | "other";

/** The kinds of every top-level definition in a GraphQL document. */
export function operationKinds(document: string): OperationKind[] {
  const kinds: OperationKind[] = [];
  let braces = 0;
  let parens = 0;
  let atStart = true;
  const n = document.length;
  for (let i = 0; i < n; ) {
    const c = document[i]!;
    if (c === "#") {
      while (i < n && document[i] !== "\n" && document[i] !== "\r") i++;
      continue;
    }
    if (c === '"') {
      if (document.startsWith('"""', i)) {
        i += 3;
        while (i < n && !document.startsWith('"""', i)) i += document.startsWith('\\"""', i) ? 4 : 1;
        i += 3;
      } else {
        i++;
        while (i < n && document[i] !== '"' && document[i] !== "\n") i += document[i] === "\\" ? 2 : 1;
        i++;
      }
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(document[j]!)) j++;
      if (atStart && braces === 0 && parens === 0) {
        const word = document.slice(i, j);
        kinds.push(word === "query" || word === "mutation" || word === "subscription" || word === "fragment" ? word : "other");
        atStart = false;
      }
      i = j;
      continue;
    }
    if (c === "(") parens++;
    else if (c === ")") parens = Math.max(0, parens - 1);
    else if (c === "{") {
      if (atStart && braces === 0 && parens === 0) {
        kinds.push("query"); // the shorthand `{ … }` is a query
        atStart = false;
      }
      braces++;
    } else if (c === "}") {
      braces = Math.max(0, braces - 1);
      if (braces === 0 && parens === 0) atStart = true;
    }
    i++;
  }
  return kinds;
}

const READ_KEYS: ReadonlySet<string> = new Set(["query", "operationName", "variables"]);

/** The documents in a GraphQL-over-HTTP body (`{ query }` or a batch of them), or null if it is not one. */
export function graphqlDocuments(body: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const docs: string[] = [];
  for (const item of items) {
    const q = item && typeof item === "object" ? (item as { query?: unknown }).query : undefined;
    if (typeof q !== "string") return null;
    // Only the GraphQL-over-HTTP keys a query needs. Any other (extensions.persistedQuery, documentId,
    // a server's own id or queryId) may name a stored document that runs instead of the visible one.
    if (Object.keys(item as object).some((k) => !READ_KEYS.has(k))) return null;
    docs.push(q);
  }
  return docs.length ? docs : null;
}

/** True when every definition in the body is a query or a fragment, and there is at least one query. */
export function isQueryOnly(body: string): boolean {
  const docs = graphqlDocuments(body);
  if (!docs) return false;
  return docs.every((d) => {
    const kinds = operationKinds(d);
    return kinds.includes("query") && kinds.every((k) => k === "query" || k === "fragment");
  });
}

/** True for a path whose last segment is `graphql`, in any case (`/graphql`, `/api/GraphQL`): servers often route case-insensitively. */
export function isGraphqlPath(pathname: string): boolean {
  return /\/graphql\/?$/i.test(pathname);
}
