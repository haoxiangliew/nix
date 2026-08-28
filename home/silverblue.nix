{ config, pkgs, ... }:

{
  home = {
    # ostree bind-mounts /home -> /var/home, and Home Manager compares this
    # against $HOME at activation time.
    homeDirectory = "/var/home/${config.home.username}";

    packages = with pkgs; [
      unstable.podman-tui
    ];
  };

  nix.gc = {
    automatic = true;
    randomizedDelaySec = "45min";
    options = "--delete-older-than 30d";
  };

  # The host installs Ghostty through rpm-ostree or Flatpak, not Home Manager,
  # and there is no systemd user session here to manage it.
  programs.ghostty = {
    package = null;
    systemd.enable = false;
    settings.font-size = 9;
  };

  # Nothing here resolves MIME types through the Nix profile. No GUI packages
  # come from Home Manager, and targets.genericLinux is off, so XDG_DATA_DIRS
  # never includes the profile. Nothing can read the generated database, so skip
  # it and the three packages it pulls in.
  xdg.mime.enable = false;

  # An rpm-ostree overlay installs 1Password, so the agent socket is in $HOME
  # and op-ssh-sign is at an FHS path rather than in the Nix store.
  hx.onePassword = {
    agentSocket = "${config.home.homeDirectory}/.1password/agent.sock";
    sshSignProgram = "/opt/1Password/op-ssh-sign";
  };
}
