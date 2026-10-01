
By passing XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS, and mounting /run read-only, any application inside this bwrap sandbox can command the host via D-Bus. It has an immediate, unpatched avenue to escape the container, steal secrets, or execute arbitrary code on your host system. [2, 3]
To close this specific hole without breaking the things you actually want (like desktop notifications or the file picker), you need to integrate xdg-dbus-proxy. [4]

## The Fix: Filter D-Bus with a Proxy
Instead of binding the host's actual D-Bus socket inside the sandbox, you spin up a companion xdg-dbus-proxy process on the host before running bwrap. [5]
The proxy creates a filtered mock socket. You then mount only that mock socket into the sandbox's /run directory. [4]
## Step 1: Create a Filtered Proxy Sockets Directory
Before invoking bwrap, create a secure location on the host to hold the proxy socket: [5]

PROXY_DIR="${XDG_RUNTIME_DIR}/sandbox-bus-proxy"
mkdir -p "$PROXY_DIR"

## Step 2: Launch xdg-dbus-proxy
Run the proxy to intercept and filter the host's D-Bus session. You must explicitly allowlist the names or portals the app needs: [4]

xdg-dbus-proxy "$DBUS_SESSION_BUS_ADDRESS" "$PROXY_DIR/bus" \
    --filter \
    --talk=org.freedesktop.Notifications \
    --talk=org.freedesktop.portal.Desktop \
    --talk=org.freedesktop.portal.Documents &
PROXY_PID=$!


*
* --filter: Denies everything by default. This automatically blocks dangerous escapes like org.freedesktop.systemd1 and org.freedesktop.Flatpak.
* --talk=...: Safely exposes only the APIs your app needs to work normally (e.g., standard notifications or secure XDG desktop portals). [3, 4, 6, 7]
*

## Step 3: Update your bwrap Logic
Modify guiDisplayBinds and buildBwrapCommand to completely isolate /run and map the proxy socket over the expected D-Bus path.

   1. Stop binding the host's /run. Use --tmpfs /run instead to give the sandbox an empty, clean runtime directory.
   2. Bind only the proxy socket. Use --ro-bind to point to the proxy socket file.
   3. Point the environment variable to the fake socket. [8]

Your generated bwrap flags should look like this:

# Clean out /run and mount the proxy precisely where the host socket used to be
--tmpfs /run \
--dir /run/user/$(id -u) \
--ro-bind "$PROXY_DIR/bus" "/run/user/$(id -u)/bus" \
--setenv DBUS_SESSION_BUS_ADDRESS "unix:path=/run/user/$(id -u)/bus"

## Step 4: Clean Up
When your bwrap command terminates, kill the background proxy:

kill "$PROXY_PID"
rm -rf "$PROXY_DIR"

------------------------------
## Security Trade-Offs of this Approach

| Feature | Unfiltered Host D-Bus (Current) | xdg-dbus-proxy (Recommended) |
|---|---|---|
| Sandbox Escape | Trivial (via systemd or flatpak-spawn) | Blocked (unapproved calls dropped by proxy) |
| Credential Theft | High Risk (full read access to GNOME Keyring) | Blocked (unless --talk=org.freedesktop.secrets is added) |
| XDG Portals | Available, but completely bypassable | Enforced (app must use secure portals for files/screens) |
| Setup Complexity | None (Inherits host settings) | High (Requires managing a background proxy process) |

If you are writing this architecture in a specific language (like Python, Go, or a Bash wrapper), let me know. I can give you the exact code to cleanly fork the proxy process and bind its file descriptors securely.

[1] [https://blog.ce9e.org](https://blog.ce9e.org/posts/2025-10-11-terminal-sandbox/)
[2] [https://github.com](https://github.com/containers/bubblewrap/blob/main/README.md)
[3] [https://blog.ce9e.org](https://blog.ce9e.org/posts/2025-10-11-terminal-sandbox/)
[4] [https://sloonz.github.io](https://sloonz.github.io/posts/sandboxing-2/)
[5] [https://wiki.archlinux.org](https://wiki.archlinux.org/title/Bubblewrap/Examples)
[6] [https://man.archlinux.org](https://man.archlinux.org/man/xdg-dbus-proxy.1.en)
[7] [https://bugs.launchpad.net](https://bugs.launchpad.net/bugs/1811824)
[8] [https://sloonz.github.io](https://sloonz.github.io/posts/sandboxing-1/)
