/** GitLab GraphQL: review notes, bot flags and diff stats for a batch of MRs (readable without a token on public projects, unlike REST notes). */
export interface GqlUser {
  username: string;
  bot: boolean;
}

export interface GqlNotesPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: { system: boolean; body: string; createdAt: string; author: GqlUser | null }[];
}

export interface GqlMergeRequest {
  iid: string;
  diffStatsSummary: { additions: number; deletions: number } | null;
  author: GqlUser | null;
  mergeUser: GqlUser | null;
  approvedBy: { nodes: GqlUser[] };
  reviewers: { nodes: GqlUser[] };
  notes: GqlNotesPage;
}

const USER = "username bot";
const NOTES = `pageInfo { hasNextPage endCursor } nodes { system body createdAt author { ${USER} } }`;

export const MR_BATCH_QUERY = `query($path: ID!, $iids: [String!], $first: Int) {
  project(fullPath: $path) {
    mergeRequests(iids: $iids, first: $first) {
      nodes {
        iid
        diffStatsSummary { additions deletions }
        author { ${USER} }
        mergeUser { ${USER} }
        approvedBy(first: 100) { nodes { ${USER} } }
        reviewers(first: 100) { nodes { ${USER} } }
        notes(first: 100) { ${NOTES} }
      }
    }
  }
}`;

export const MORE_NOTES_QUERY = `query($path: ID!, $iid: String!, $after: String) {
  project(fullPath: $path) { mergeRequest(iid: $iid) { notes(first: 100, after: $after) { ${NOTES} } } }
}`;
