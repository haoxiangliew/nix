{ config, ... }:

{
  # ostree bind-mounts /home -> /var/home, and Home Manager compares this
  # against $HOME at activation time.
  home.homeDirectory = "/var/home/${config.home.username}";

  # Ghostty is provided by the host (rpm-ostree/Flatpak), not Home Manager,
  # and this host has no systemd user session managing it.
  programs.ghostty = {
    package = null;
    systemd.enable = false;
    settings.font-size = 10;
  };

  # 1Password is installed via an rpm-ostree overlay: the agent socket sits in
  # $HOME and op-ssh-sign lives at the FHS path rather than a Nix store path.
  hx.onePassword = {
    agentSocket = "${config.home.homeDirectory}/.1password/agent.sock";
    sshSignProgram = "/opt/1Password/op-ssh-sign";
  };
}
