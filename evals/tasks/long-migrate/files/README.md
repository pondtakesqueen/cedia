# handlers

Each handler in src/handlers/ takes a request object and reports either a result or an HttpError.

Today they use the callback style: `handler(req, done)` with `done(err)` or `done(null, result)`, on db's
callback API. They are moving to `async handler(req): Promise<result>` that throws HttpError, on
`db.promises`. The behaviour (results, statuses, messages, what is written) must not change.
