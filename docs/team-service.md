# Team service: setup and operation

The team service lets the owner share chosen task metadata with invited people. They can then comment on those tasks and assign them. It is a small self-hosted program: one Node process, its own SQLite file in its own data folder, and its own HTTPS listener. It does not depend on any particular host, cloud, region or identity provider. You configure it with any standards-compliant OpenID Connect (OIDC) issuer.

## What is shared, and what never is

- **Shared:** the title, description and status of each task you choose to share. Before anything is sent, the app shows the exact JSON. It also shares comments (plain text), assignments, member names and emails, and project roles.
- **Never shared:** file paths, file contents, Git data, first messages and prompts, transcripts, terminal input or output, sessions, attempts, notes, canvas and credentials.
- **What an assignment means:** it is coordination only. An assignee gets no access to anyone's terminals, files or machine, and nothing runs anywhere because of it.
- **Team tokens:** a team sign-in never works against the desktop app's local core, its remote-access gateway or agent control. Those are separate authorities.

## Requirements

- Node.js 24 or newer on the machine that runs the service.
- An OIDC identity provider that you control or that your organization uses. It must support:
  - the Authorization Code flow with PKCE (`S256`);
  - signed ID tokens (RS256, ES256, PS256 or EdDSA; symmetric `HS*` algorithms are refused);
  - a discovery document at `<issuer>/.well-known/openid-configuration`;
  - a published JWKS.
- For any listener that is not loopback: a TLS certificate and key for the service's public name, or a reverse proxy that terminates TLS and forwards to a loopback listener.

## Build

```sh
npm ci
npm run build          # writes dist/team/server.mjs (one file; openid-client and jose are bundled)
```

Copy `dist/team/server.mjs` to the service machine. It has no native dependencies.

## Register the desktop app with your identity provider

The desktop app signs in through the system browser and receives the answer on a loopback address on the user's own computer (RFC 8252). The team service is the OIDC client: it exchanges the code and checks the ID token. Create one client (application) in your provider with these settings:

| Setting | Value |
| --- | --- |
| Grant / flow | Authorization Code, with PKCE `S256` |
| Redirect URI | `http://127.0.0.1/callback`, meaning any port, as RFC 8252 section 7.3 describes. If your provider needs an exact port, choose one (for example `http://127.0.0.1:53682/callback`) and use that exact value in the config below. |
| Scopes | `openid email profile` |
| Client authentication | A client secret (`client_secret_basic` or `client_secret_post`) if your provider issues one. Otherwise `none`, as a public client with PKCE. |
| ID token signing | An asymmetric algorithm (RS256 is the most common) |

Providers name these settings differently. For example, a "native", "desktop" or "public" application type often allows loopback redirects, and a "confidential" or "web" type issues a secret. Check your provider's own documentation for loopback redirect and PKCE support.

The same settings apply to hosted providers (such as Google, Okta or Auth0) and to self-hosted ones (such as Keycloak). Listing them here is not an endorsement. Nothing in the service is specific to one provider.

## Configure the service

Create `team-service.json`. Paths are relative to the config file:

```json
{
  "dataDir": "./team-data",
  "listen": {
    "host": "0.0.0.0",
    "port": 8790,
    "certFile": "./tls/cert.pem",
    "keyFile": "./tls/key.pem",
    "publicOrigin": "https://team.example.com:8790"
  },
  "oidc": {
    "issuer": "https://login.example.com/realms/acme",
    "clientId": "agent-workspace",
    "clientSecretFile": "./oidc-client-secret.txt",
    "tokenEndpointAuthMethod": "client_secret_basic",
    "redirectUri": "http://127.0.0.1/callback",
    "allowedAudiences": [],
    "algorithms": ["RS256"]
  },
  "sessionMinutes": 60,
  "refreshDays": 14
}
```

- **`issuer`** must equal the `issuer` in the provider's discovery document exactly, or startup sign-ins fail.
- **`clientSecretFile`** or **`clientSecretEnv`** (the name of an environment variable) keep the secret out of the config file. Omit both for a public client.
- **`allowedAudiences`** lists extra audiences an ID token may also name. The client ID is always required. An ID token with several audiences must name this client in `azp`.
- **`listen`:** a non-loopback `host` requires `certFile`, `keyFile` and `publicOrigin` (the exact HTTPS origin clients use). For a reverse proxy, keep `host` at `127.0.0.1` and set no TLS files. The service refuses non-loopback plain HTTP.
- **`sessionMinutes`** sets the life of a session token (default 60). **`refreshDays`** sets the life of the rotating refresh token (default 14).

Start the service:

```sh
node server.mjs --config team-service.json
```

The data folder is created with mode 0700 and `team.sqlite` with mode 0600. Do not point two service processes, or anything else, at the same data folder.

## Create the team and its owner

There is no public sign-up. Create a team and a one-time owner invitation on the service machine:

```sh
node server.mjs --config team-service.json init-team --name "Acme" [--owner-email you@example.com] [--hours 72]
```

The command prints the invitation code once. Only its hash is stored. With `--owner-email`, the code works only for a sign-in whose ID token carries that email and does not mark it unverified.

In the desktop app:

1. Choose **Team** in the sidebar footer.
2. Enter the service address (for example `https://team.example.com:8790`) and the code, then click **Connect**.
3. Your browser opens your provider's sign-in page. Afterwards, return to the app.

The service identifies you by the issuer and subject in your ID token, not by your email. Your sign-in is kept only in the operating system's secret storage:

- macOS: Keychain.
- Windows: DPAPI.
- Linux: a Secret Service keyring such as GNOME Keyring or KWallet.

On a Linux desktop with no unlocked keyring, Electron can offer only an unencrypted fallback. The app then turns team sign-in off rather than store the session in plain text.

## Projects, invitations and roles

- **Publishing a folder.** In **Team**, a team owner can publish the open folder as a new team project. A project admin can publish it to an existing project.
- **Sharing a task.** Publishing a folder sends nothing by itself. To share a task, open it on the Board's **Tasks** view and choose **Share with team…**. The preview shows exactly what will be sent. Local edits are not sent automatically: the card shows **Local edits not shared** until you review and send an update.
- **Inviting people.** Admins invite from a project. Choose a role and, optionally, an email that the ID token must carry (and not mark unverified). Send the code privately. It works once and expires after 72 hours by default (30 days at most).

Roles are checked by the service at every query and change:

| Role | Can |
| --- | --- |
| Team owner | Everything below in every team project; create projects; invite to the team; remove people from the team; read the audit log |
| Project admin | Manage the project's members and roles; share, update and remove shared tasks; assign any active member who is not a viewer; delete any comment (moderation, audited) |
| Member | Read; comment; edit and delete their own comments; assign themselves to an unassigned task and unassign themselves |
| Viewer | Read only |

Other rules:

- Removing someone from a project ends their access to it immediately, including for a request already in flight, and clears their assignments there. Their comments keep their name. The next time their app syncs, it deletes its copy of that project's tasks, comments and members and drops anything it had not sent.
- A pending invitation cannot be assigned.
- IDs from another team, guessed IDs and missing IDs all get the same "no access" answer.
- Comments are plain text, at most 4,000 characters. Control characters and bidirectional-override characters are removed, and nothing is turned into links, mentions or HTML.
- Rate limits per person: 30 comment changes per minute, 20 invitations per hour, 600 calls per minute. Sign-in attempts are limited to 30 per minute per address.

## Sync behaviour

- **What the app keeps.** The desktop keeps a bounded copy of each project's shared tasks, comments, assignments and members: at most 5,000 entries per project, oldest comments dropped first.
- **How it syncs.** It syncs every 15 seconds and after each change, by reading an ordered change feed from its last position.
- **Changes made offline.** Comments and assignment changes made offline wait in a visible outbox (at most 200), each with an immutable change ID. A change whose answer was lost is sent again with the same ID, and the service applies it once.
- **Revalidation.** Each sync first asks the service which projects you can still reach. Projects you lost access to are purged before anything queued is sent.
- **Conflicts.** A change made against an older version is shown as a conflict. **Apply to latest** resends it against the current version; **Discard** drops it. Nothing is merged silently.
- **No resurrection.** Deleted tasks and comments are never brought back by an old or replayed page.
- **Disconnect.** Disconnecting signs out, deletes the stored session and removes this computer's copy of team data. Your local tasks stay.

## Sessions and keys

- **Sign-in checks.** Each sign-in checks the following exactly: issuer, audience and authorized party, nonce, state, the PKCE verifier, ID token signature against the issuer's JWKS, and token lifetime (60 seconds of clock tolerance).
- **Key rotation.** A new key ID makes the service fetch the JWKS again, at most every 30 seconds. Keys are trusted for up to 10 minutes after they were fetched, so a key the provider retires stops working within that time.
- **Login attempts.** Each attempt expires after 10 minutes and works once.
- **Service sessions.** Session and refresh tokens are random, and only their hashes are stored. Refreshing rotates both tokens. Presenting an already-rotated refresh token revokes the whole sign-in. **Disconnect** revokes the session on the service.

## Backups, retention and audit

- **Backup.** Take a consistent copy while the service runs:

  ```sh
  node server.mjs --config team-service.json backup /secure/place/team-$(date +%F).sqlite
  ```

- **Restore.** Stop the service, replace `team.sqlite` with the copy, delete `team.sqlite-wal` and `team.sqlite-shm`, then start the same or a newer version. A store written by a newer service version is refused.
- **Audit log.** The service records invitations, role changes, removals, published task changes, assignments and comment moderation. Entries have an actor, target and time, never comment text. Team owners read it through the API (`audit.list`).
- **Retention.** Retention and deletion policy for the audit log, removed tasks, comments and expired sessions is an owner decision that has not been made. Today:
  - nothing is purged automatically, except expired sessions after their refresh lifetime;
  - deleted comments keep their row with the text removed.

## Not decided, and not done

These need owner decisions before production use:

- hosting, region and backups;
- which identity provider to use;
- an invitation and retention policy.

Not built: email delivery of invitations, team deletion and ownership transfer through the app, live push (the app polls), presence, attachments and any terminal or file sharing.
