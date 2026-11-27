{
  config,
  lib,
  pkgs,
  ...
}:

{
  options.services.tailscale-user.hostname = lib.mkOption {
    type = lib.types.str;
    example = "haos-macbook-pro-user";
    description = "Name of this device on the tailnet.";
  };

  config = {
    home = {
      packages = [
        (pkgs.writeShellScriptBin "tailscale-user" ''
          exec ${lib.getExe' pkgs.tailscale "tailscale"} --socket=${lib.escapeShellArg "${config.xdg.stateHome}/tailscale-user/tailscaled.sock"} "$@"
        '')
      ];
    };

    # Run `tailscale-user login` once to sign in.
    launchd.agents.tailscaled-user = {
      enable = true;
      config = {
        ProgramArguments = [
          (lib.getExe' pkgs.tailscale "tailscaled")
          "--tun=userspace-networking"
          "--statedir=${config.xdg.stateHome}/tailscale-user"
          "--socket=${config.xdg.stateHome}/tailscale-user/tailscaled.sock"
          # The Tailscale app may already use the default port.
          "--port=0"
          "--no-logs-no-support"
          # `Locked = false` lets `tailscale-user set` change settings.
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
        # Without TS_LOGS_DIR, tailscaled keeps its log settings in /Library/Tailscale if that exists,
        # or else in ~/.local/share/tailscale.
        EnvironmentVariables.TS_LOGS_DIR = "${config.xdg.stateHome}/tailscale-user";
        KeepAlive = true;
        RunAtLoad = true;
        StandardOutPath = "${config.xdg.stateHome}/tailscale-user/tailscaled.log";
        StandardErrorPath = "${config.xdg.stateHome}/tailscale-user/tailscaled.log";
      };
    };

    programs.ssh.settings.tailscale-user = {
      header = "Match exec \"${config.home.profileDirectory}/bin/tailscale-user ip -1 %h >/dev/null 2>&1\"";
      ProxyCommand = "${config.home.profileDirectory}/bin/tailscale-user nc %h %p";
    };
  };
}
