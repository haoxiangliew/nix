# haoxiangliew's nix config

this is probably v4? of my nix config with a few stated goals

1. offload unstable root OS backing layers to the following:
  - https://github.com/haoxiangliew/silverblue on `x86_64-linux`
    - please reference that repo for installation
  - MacOS on `aarch64-darwin`

2. keep things as rootless, especially on Silverblue

**why not NixOS?**

- i have work to do, nix should be managing my developer environment, not my workstation.

### Silverblue

prerequisites: https://github.com/haoxiangliew/silverblue

#### `nix build` init

on boot, we don't have `home-manager` or anything from the derivation in the `$PATH`

```bash
nix run home-manager/release-${home.stateVersion} -- switch --flake .#$USER@$HOSTNAME
```
subsequent runs can just use `home-manager switch --flake .#$USER@$HOSTNAME`

### Darwin

prerequisites:
- install determinate nix: https://docs.determinate.systems/determinate-nix/#getting-started
- install homebrew: https://brew.sh/

#### `nix build` init

on boot, we don't have `darwin-rebuild` or anything from the derivation in the `$PATH`

```bash
sudo -H nix run github:LnL7/nix-darwin/nix-darwin-26.05#darwin-rebuild -- switch --flake .#$USER@$HOSTNAME
```
subsequent runs can just use `sudo darwin-rebuild switch --flake .#$USER@$HOSTNAME`

### `trusted-users`

add your user to `/etc/nix/nix.conf` / `/etc/nix/nix.custom.conf` (darwin determinate-nix) for `nixConfig` binary caches to apply
```bash
trusted-users = root $USER
```

### `fish` init

```bash
echo "$HOME/.nix-profile/bin/fish" | sudo tee -a /etc/shells
chsh -s "$HOME/.nix-profile/bin/fish"
```

#### 1Password

due to changes by 1Password, a nightly release is required for operation in `rpm-ostree` environments like fedora silverblue:

[https://www.1password.community/1password-at-home-31/update-to-fedora-silverblue-fails-25075](https://www.1password.community/1password-at-home-31/update-to-fedora-silverblue-fails-25075)

[yama](https://support.1password.com/linux-ptrace-scope-issue/#if-yama-is-loaded) will also need to be set up for importing / exporting files:

```bash
sudo sysctl -w kernel.yama.ptrace_scope=1 | sudo tee -a /etc/sysctl.conf
```
