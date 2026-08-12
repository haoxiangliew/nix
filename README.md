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

#### `nix build` init

on boot, we don't have `home-manager` or anything from the derivation in the `$PATH`

```bash
nix run home-manager/release-${home.stateVersion} -- switch --flake .#$USER@$HOSTNAME
```
subsequent runs can just use `home-manager switch --flake .#$USER@$HOSTNAME`

#### `fish` init

```bash
echo "$HOME/.nix-profile/bin/fish" | sudo tee -a /etc/shells
chsh -s "$HOME/.nix-profile/bin/fish"
```
#### 1Password
Due to changes by 1Password, a nightly release is required for operation in `rpm-ostree` environments like Fedora Silverblue:

[https://www.1password.community/1password-at-home-31/update-to-fedora-silverblue-fails-25075](https://www.1password.community/1password-at-home-31/update-to-fedora-silverblue-fails-25075)

[Yama](https://support.1password.com/linux-ptrace-scope-issue/#if-yama-is-loaded) will also need to be set up for importing / exporting files:

```bash
sudo sysctl -w kernel.yama.ptrace_scope=1 | sudo tee -a /etc/sysctl.conf
```
