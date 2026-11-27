{
  config,
  lib,
  pkgs,
  ...
}:

let
  stateDir = "${config.xdg.stateHome}/tailscale-user";
  socket = "${stateDir}/tailscaled.sock";

  tailscaledArgs = [
    (lib.getExe' pkgs.tailscale "tailscaled")
    "--tun=userspace-networking"
    "--statedir=${stateDir}"
    "--socket=${socket}"
    # A system tailscaled or the Tailscale app may already use the default port.
    "--port=0"
    "--no-logs-no-support"
    "--config=${
      pkgs.writeText "tailscaled-user.json" (
        builtins.toJSON {
          Version = "alpha0";
          Locked = false;
          Hostname = config.services.tailscale-user.hostname;
          RunSSHServer = true;
        }
      )
    }"
  ];
in
{
  options.services.tailscale-user.hostname = lib.mkOption {
    type = lib.types.str;
    example = "haos-macbook-pro-user";
    description = "Name of this device on the tailnet.";
  };

  config = {
    home.packages = [
      (pkgs.writeShellScriptBin "tailscale-user" ''
        exec ${lib.getExe' pkgs.tailscale "tailscale"} --socket=${lib.escapeShellArg socket} "$@"
      '')
    ];

    # Home Manager ignores launchd agents on Linux and systemd units on macOS.
    launchd.agents.tailscaled-user = {
      enable = true;
      config = {
        ProgramArguments = tailscaledArgs;
        EnvironmentVariables.TS_LOGS_DIR = stateDir;
        KeepAlive = true;
        RunAtLoad = true;
        StandardOutPath = "${stateDir}/tailscaled.log";
        StandardErrorPath = "${stateDir}/tailscaled.log";
      };
    };

    systemd.user.services.tailscaled-user = {
      Unit.Description = "Userspace tailscaled for ${config.services.tailscale-user.hostname}";
      Service = {
        ExecStart = lib.escapeShellArgs tailscaledArgs;
        Environment = [ "TS_LOGS_DIR=${stateDir}" ];
        Restart = "always";
        RestartSec = 5;
      };
      Install.WantedBy = [ "default.target" ];
    };

    programs.ssh.settings.tailscale-user = {
      header = "Match exec \"${config.home.profileDirectory}/bin/tailscale-user ip -1 %h >/dev/null 2>&1\"";
      ProxyCommand = "${config.home.profileDirectory}/bin/tailscale-user nc %h %p";
    };
  };
}
