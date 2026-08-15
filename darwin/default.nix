{ ... }:

{
  # let determinate nix handle nix on darwin
  nix.enable = false;
  documentation.enable = false;

  programs.fish.enable = true;

  security.pam.services.sudo_local.touchIdAuth = true;
}
