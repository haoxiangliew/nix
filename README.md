# haoxiangliew's nix config

this is probably v4? of my nix config, with a few stated goals:

1. offload the unstable root OS layers to:
   - [haoxiangliew/silverblue](https://github.com/haoxiangliew/silverblue) on `x86_64-linux`
     - see that repo for installation
   - macOS on `aarch64-darwin`

2. keep things as rootless as possible, especially on Silverblue

**why not NixOS?** i have work to do. nix should manage my developer environment, not my workstation.

### `trusted-users`

do this before the first switch. the `nixConfig` binary caches apply only to trusted users, so an untrusted build ignores them and compiles everything from source. add yours to `/etc/nix/nix.conf`, or to `/etc/nix/nix.custom.conf` on darwin determinate-nix:

```bash
trusted-users = root $USER
```

### Silverblue

prerequisites: [haoxiangliew/silverblue](https://github.com/haoxiangliew/silverblue)

#### bootstrap `home-manager`

on a fresh install, `home-manager` isn't in `$PATH` yet

```bash
nix run home-manager/release-26.05 -- switch --flake .#$USER@$HOSTNAME
```

after that, `home-manager switch --flake .#$USER@$HOSTNAME` is enough

#### captive portals

the root of all evil. we run DNS-over-TLS through `systemd-resolved`, and a captive portal has to hijack DNS to send you to its sign-in page. it cannot hijack TLS, so nothing resolves and the sign-in page never appears.

`captive-portal` steps through the fix with y/N prompts. it turns DNS-over-TLS off on the connected link, then re-runs NetworkManager's connectivity check so GNOME offers "Sign in to network". after you sign in, it reverts the link and flushes the caches. the revert runs on every exit path, so ctrl-c is safe.

```bash
captive-portal            # picks the connected wifi link
captive-portal wlp1s0     # or name one
```

or by hand:

```bash
resolvectl dnsovertls wlp1s0 no
nmcli networking connectivity check
# portal
```

GNOME should now offer "Sign in to network". then put the `systemd-resolved` settings back:

```bash
resolvectl revert wlp1s0
resolvectl flush-caches
```

#### 1Password

the stable 1Password release no longer works under `rpm-ostree` systems like fedora silverblue, so it needs a nightly build. see the [1password community thread](https://www.1password.community/1password-at-home-31/update-to-fedora-silverblue-fails-25075).

you also need to set up [yama](https://support.1password.com/linux-ptrace-scope-issue/#if-yama-is-loaded) before you can import or export files:

```bash
sudo sysctl -w kernel.yama.ptrace_scope=1 | sudo tee -a /etc/sysctl.conf
```

### Darwin

prerequisites:
- install [determinate nix](https://docs.determinate.systems/determinate-nix/#getting-started)
- install [homebrew](https://brew.sh/)

#### bootstrap `darwin-rebuild`

on a fresh install, `darwin-rebuild` isn't in `$PATH` yet

```bash
sudo -H nix run github:LnL7/nix-darwin/nix-darwin-26.05#darwin-rebuild -- switch --flake .#$USER@$HOSTNAME
```

after that, `sudo darwin-rebuild switch --flake .#$USER@$HOSTNAME` is enough

### `fish` as the login shell

```bash
echo "$HOME/.nix-profile/bin/fish" | sudo tee -a /etc/shells
chsh -s "$HOME/.nix-profile/bin/fish"
```
