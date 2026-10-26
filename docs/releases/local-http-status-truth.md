# Local provider HTTP failure states

Explicit HTTP 401/403 authentication failures and 429 rate limits now retain their correct failure states when the server sends an oversized or stalled error body. Scout cancels that unneeded body without retrying the request. Authentication failures establish the existing durable sign-in barrier until a real successful completion.

Response-size limits, total deadlines, explicit cancellation, schema fallback and transient retry budgets remain in force. No configuration or workspace migration is required.
