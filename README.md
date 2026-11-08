# BMW Parts World (Node.js)

Independent BMW parts catalog with a Node.js backend. There are **no dependencies**: it uses only Node's built-in modules, so you don't need to run `npm install`.

## Run it

```bash
# Node 18 or newer
ADMIN_PASSWORD="choose-a-strong-password" npm start
```

- Store: http://localhost:3000
- Admin: http://localhost:3000/admin

If `ADMIN_PASSWORD` isn't set, the server makes up a temporary password and prints it in the console when it starts.

On Windows PowerShell:

```powershell
$env:ADMIN_PASSWORD="choose-a-strong-password"; npm start
```

## Settings (environment variables)

| Variable         | Default   | Purpose                                              |
|------------------|-----------|------------------------------------------------------|
| `ADMIN_PASSWORD` | random    | Password for /admin                                  |
| `PORT`           | `3000`    | Port to listen on                                    |
| `HOST`           | `0.0.0.0` | Interface to bind                                    |
| `DATA_DIR`       | `./data`  | Location of `products.json` and the `uploads/` folder |
| `NODE_ENV`       | –         | Set `production` to mark the cookie `Secure` (HTTPS needed) |

## Project structure

```
server.js          HTTP server, REST API, auth, file storage
public/index.html  Store + admin markup
public/styles.css  Styles
public/app.js      Front-end logic (talks to the API)
data/              Created automatically: products.json + uploads/
```

## API

| Method | Path                  | Auth  | Description                    |
|--------|-----------------------|-------|--------------------------------|
| GET    | `/api/products`       | –     | List products                  |
| POST   | `/api/login`          | –     | `{ "password": "..." }`        |
| POST   | `/api/logout`         | –     | End the session                |
| GET    | `/api/session`        | –     | `{ authenticated: true/false }` |
| POST   | `/api/products`       | admin | Create (optional `imageData`, as a data URL) |
| PUT    | `/api/products/:id`   | admin | Update (`imageData` or `removeImage`) |
| DELETE | `/api/products/:id`   | admin | Delete a product and its photo |

## Notes for going live

- Put it behind HTTPS (for example nginx, Caddy, Render or Railway) and set `NODE_ENV=production`.
- Back up the `data/` folder. On hosts with temporary disks, point `DATA_DIR` at a persistent volume.
- Sessions are kept in memory, so restarting the server logs the admin out.
- Checkout and payments are not built yet.
