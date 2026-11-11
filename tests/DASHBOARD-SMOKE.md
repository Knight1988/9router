# Dashboard browser smoke

This opt-in test visits eight dashboard pages in headless Chrome and fails on a missing page marker, HTTP navigation failure, login redirect, or uncaught browser exception. The combos page uses intercepted, synthetic combo/provider/settings responses to exercise a populated smart-routing card and its unconfigured-router branch. It does **not** test real combo API persistence or provider/model calls. The browser blocks non-GET/HEAD requests and off-origin requests.

Run only against a fresh, disposable app instance with login disabled, bound to loopback. Do not point it at production or a developer's normal data directory. The test rejects non-loopback URLs; loopback alone does not establish that an instance is disposable.

Example CI setup from the repository root, with dependencies and Google Chrome already installed (use `CHROME_PATH` if Chrome is elsewhere):

```bash
set -eu
DATA_DIR="$(mktemp -d)"
export DATA_DIR
cleanup() { kill "$app_pid" 2>/dev/null || true; wait "$app_pid" 2>/dev/null || true; rm -rf "$DATA_DIR"; }
npx next dev --webpack --hostname 127.0.0.1 --port 21983 >"$DATA_DIR/app.log" 2>&1 &
app_pid=$!
trap cleanup EXIT
for i in $(seq 1 120); do
  if curl -fsS http://127.0.0.1:21983/api/settings/require-login >/dev/null; then break; fi
  sleep 1
done
# This changes only the disposable database created above, never an existing DB.
python3 - <<'PY'
import json, os, sqlite3
path = os.path.join(os.environ['DATA_DIR'], 'db', 'data.sqlite')
with sqlite3.connect(path) as db:
    db.execute('INSERT OR REPLACE INTO settings (id, data) VALUES (1, ?)',
               (json.dumps({'requireLogin': False}),))
PY
(cd tests && DASHBOARD_SMOKE_URL=http://127.0.0.1:21983 npx vitest run unit/dashboard-pages-browser.test.js)
```

The Azure pipeline also runs this test as a mandatory pre-deployment gate against its disposable Docker app. It disables dashboard login only inside that test container, binds the CI ports to loopback, and requires Chrome or Chromium on the agent. An unavailable browser fails the job. The default unit suite skips this test unless `DASHBOARD_SMOKE_URL` is set.

Use an available port; ensure no other service is already listening before starting. The test has no credentials and does not invoke upstream inference. A successful run is a local browser smoke, not production validation.
