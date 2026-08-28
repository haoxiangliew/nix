{ config, lib, ... }:

{
  # let determinate nix handle nix on darwin
  determinateNix = {
    enable = true;
    customSettings = {
      # /etc/nix/nix.custom.conf
      trusted-users = [ "root" ] ++ lib.attrNames config.home-manager.users;
      auto-optimise-store = true;
    };
  };

  documentation.enable = false;

  programs.fish.enable = true;

  security.pam.services.sudo_local.touchIdAuth = true;
}
