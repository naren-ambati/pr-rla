/**
 * JSON-over-HTTP transport shared by the built-in GitLab and Bitbucket providers. Since U3 it lives
 * in the public SDK as `pr-rla/http` (src/sdk/http.ts) and is re-exported here, so the built-ins'
 * imports did not change. Behind the fetch broker the built-ins construct it with `maxRetries: 0`.
 */
export { HttpClient, HttpError, GAVE_UP, nextLink, isoUtcSeconds, waitFromHeaders, type HttpClientOptions, type RequestOptions } from "../sdk/http.js";
