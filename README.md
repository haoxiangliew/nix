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
