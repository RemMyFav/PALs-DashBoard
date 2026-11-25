# PALs Psychometrics

PALs Psychometrics is a survey application for creating, assigning, completing, and anonymously exporting 1–5 psychometric questionnaire responses. It provides email registration, sign-in, sign-out, and separate participant and administrator access. Dependency installation, frontend builds, backend execution, and tests run inside Docker. The host only needs Docker Desktop with Linux containers and Docker Compose v2; Node, npm, and pnpm are not required on the host.

Administrators can create multiple survey projects by uploading CSV files. A CSV must contain exactly one `question` column. Each non-empty row in that column becomes a question in the project; every other column is ignored. The creator becomes the Survey Owner and can invite other accounts as Participants or Co-owners.

Every survey receives a globally unique 4-digit join code. Participants can be invited by email or join with the code. Their surveys appear under **My surveys**, where they answer every question with a rating from 1 to 5. A successful submission returns them to the list and marks the survey **Completed** in green. Owners and Co-owners can see completion counts, download the current response matrix, review questions, invite people, and switch accounts between Participant and Co-owner access. Only the Owner can delete the complete project.

Response exports are anonymous: the first column contains the original question text and subsequent columns are named `Respondent 01`, `Respondent 02`, and so on. Email addresses, SuperTokens user IDs, and submission timestamps are not included. Leaving a survey or losing access also deletes that user's response from future exports. This is pseudonymous rather than guaranteed anonymity; a survey with very few participants may still allow an administrator to infer an identity from outside context.

## Project structure

```text
.
├── compose.yaml          # Frontend, backend, SuperTokens Core, and PostgreSQL
├── .env.example          # Configuration reference; containers generate actual secrets
├── scripts/setup-env.mjs # Generates the local .env inside a Node container
├── frontend/
│   ├── Dockerfile        # Node build stage followed by Nginx
│   ├── nginx.conf        # Same-origin proxy for /auth and /api
│   └── src/              # React sign-in, registration, account, and admin pages
├── backend/
│   ├── Dockerfile        # Node with npm installed inside the image
│   ├── src/              # Express, SuperTokens SDK, and authorization checks
│   ├── scripts/          # Admin promotion and demotion command
│   ├── test/             # Authorization and API unit tests
│   └── integration/      # Authentication tests against the real container stack
└── auth/
    └── Dockerfile        # Official SuperTokens Core image pinned by version and digest
```

## Start the application

Start Docker Desktop in Linux container mode. From the project root, run:

```sh
docker run --rm -v "${PWD}:/workspace" -w /workspace node:24-alpine node scripts/setup-env.mjs
docker compose config --quiet
docker compose up -d --build --wait
docker compose ps
```

The first command runs a temporary Node container that generates a random database password and SuperTokens Core API key in a Git-ignored `.env` file. It never overwrites an existing `.env`. During image builds, npm installs dependencies inside Docker and does not create host `node_modules` directories.

Open [http://localhost:3000](http://localhost:3000) and select **Create account**. Passwords must contain 12–128 characters. Successful registration signs the member in automatically. Existing members can sign in with their email address and password.

To change the port, update both `WEB_PORT` and `PUBLIC_URL` in `.env`, then run `docker compose up -d --build --wait` again. The browser origin must match `PUBLIC_URL`. The default port binds only to `127.0.0.1` for local development.

## Global and per-survey roles

| Global action | Member | Administrator |
| --- | --- | --- |
| Sign in, sign out, and view their own account | Allowed | Allowed |
| Access the admin page and `/api/admin/overview` | Denied with 403 | Allowed |
| Create a new survey from CSV | Not allowed | Allowed |
| Receive surveys and join with a 4-digit code | Allowed | Allowed |
| Submit or update 1–5 ratings for a received survey | Allowed | Allowed |
| Leave a received survey | Allowed | Allowed |
| Request an administrator role during registration | Not allowed | Not allowed |

Each survey separately grants one of these access levels:

| Survey action | Participant | Co-owner | Owner |
| --- | --- | --- | --- |
| Answer and update responses | Allowed | Not allowed | Not allowed |
| View completion count and download anonymous CSV | Not allowed | Allowed | Allowed |
| View the question list | Not allowed | Allowed | Allowed |
| Invite people and change Participant/Co-owner access | Not allowed | Allowed | Allowed |
| Delete the complete survey project | Not allowed | Not allowed | Allowed |

Changing a Participant to Co-owner deletes that account's existing response, because management accounts cannot also answer the same survey. Changing a Co-owner to Participant removes management access and makes the survey available for answering.

Registration always grants the `user` role. The application has no default administrator, fixed administrator password, or automatic first-user promotion. The global `admin` role permits survey creation; per-survey Co-owner access can be granted to any registered account without making it a global administrator.

To promote a registered member, run the command with the account's email address:

```sh
docker compose exec backend npm run set-role -- <email> admin
```

To return the account to the member role, run:

```sh
docker compose exec backend npm run set-role -- <email> user
```

Replace `<email>` with the registered email address, without angle brackets. Both commands resolve the email to SuperTokens' internal immutable user ID and revoke the account's existing sessions, so the member must sign in again. There is no public role-management endpoint.

The backend reads current roles from SuperTokens for every protected request. Editing frontend code, local storage, or role fields in a request cannot grant additional access. Protected endpoints also verify that the session has not been revoked. Add future permissions in `backend/src/roles.js` and enforce them in backend routes.

## Tests inside Docker

Unit tests do not require the database:

```sh
docker compose build backend
docker compose run --rm --no-deps backend npm test
```

After the complete stack is healthy, run the integration test:

```sh
docker compose exec backend npm run test:integration
```

The integration test passes through Nginx, Express, SuperTokens Core, and PostgreSQL. It covers weak passwords, registration, duplicate emails, incorrect passwords, sign-in, token refresh, member authorization failures, administrator promotion and demotion, session revocation, and sign-out. It creates a random test account and removes it afterward.

API integration tests use header-based sessions. The browser uses cookie sessions managed by the SuperTokens SDK and should also be checked manually:

1. Register a member account.
2. Confirm that `/admin` is unavailable.
3. Promote the account with the command above.
4. Sign in again and confirm that the admin workspace appears.
5. Demote the account, sign in again, and confirm that the admin API returns 403.
6. Restart the containers and confirm that the account can still sign in.

## Routine commands and data

```sh
docker compose logs --tail=100 backend auth
docker compose down
docker compose up -d --wait
```

Accounts, roles, and sessions are stored in the PostgreSQL `auth-data` named volume. A normal `docker compose down` keeps this data. `docker compose down -v` deletes it and should not be used for routine shutdowns. Do not change the database password in `.env` while keeping the existing volume because PostgreSQL will not automatically synchronize the new password.

Only the frontend port is exposed to the host. The backend, SuperTokens Core, and PostgreSQL remain on private Docker networks. The browser reaches authentication and API routes through same-origin `/auth` and `/api` paths. The backend enables CSRF protection, origin checks, request-body limits, and per-IP rate limiting for sign-in and registration. The current in-memory rate-limit counter resets when the backend restarts.

This milestone does not include email verification, password recovery, social sign-in, free-text answers, or response analytics. Password-reset endpoints remain disabled until an email service is configured. For public deployment, configure a real HTTPS origin and TLS termination. The backend enables Secure cookies automatically when `PUBLIC_URL` uses HTTPS.

## References

- [SuperTokens email and password quickstart](https://supertokens.com/docs/quickstart)
- [SuperTokens user roles](https://supertokens.com/docs/additional-verification/user-roles/initial-setup)
- [Self-host SuperTokens](https://supertokens.com/docs/deployment/self-host-supertokens)
