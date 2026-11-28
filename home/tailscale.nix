{
  config,
  lib,
  pkgs,
  ...
}:

let
  stateDir = "${config.xdg.stateHome}/tailscale-user";
  socket = "${stateDir}/tailscaled.sock";
  inherit (config.services.tailscale-user) hostname;

  tailscaledConfig = {
    Version = "alpha0";
    Locked = false;
    Hostname = hostname;
    RunSSHServer = true;
  };

  tailscaledArgs = [
    (lib.getExe' pkgs.tailscale "tailscaled")
    "--tun=userspace-networking"
    "--statedir=${stateDir}"
    "--socket=${socket}"
    # A system tailscaled or the Tailscale app may already use the default port.
    "--port=0"
    "--no-logs-no-support"
    "--config=${pkgs.writeText "tailscaled-user.json" (builtins.toJSON tailscaledConfig)}"
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
        set -o pipefail
        tailscale=(${lib.getExe' pkgs.tailscale "tailscale"} --socket=${lib.escapeShellArg socket})
        config_flags=(
          --hostname=${lib.escapeShellArg tailscaledConfig.Hostname}
          --ssh=${lib.boolToString tailscaledConfig.RunSSHServer}
        )

        # tailscaled applies the config file's prefs only at startup. `login` and
        # the first `up` set prefs from their flags, so pass them the config's
        # prefs as flags. The caller's flags come later and override these.
        # Help works without the daemon.
        case "''${1-}" in
          login)
            exec "''${tailscale[@]}" login "''${config_flags[@]}" "''${@:2}"
            ;;
          up)
            for arg in "''${@:2}"; do
              case "$arg" in
                -h | -help | --help) exec "''${tailscale[@]}" "$@" ;;
              esac
            done
            state=$("''${tailscale[@]}" status --json --peers=false | ${lib.getExe pkgs.jq} -er .BackendState) || exit
            case "$state" in
              NoState | NeedsLogin)
                exec "''${tailscale[@]}" up "''${config_flags[@]}" "''${@:2}"
                ;;
            esac
            ;;
        esac
        exec "''${tailscale[@]}" "$@"
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
      Unit.Description = "Userspace tailscaled for ${hostname}";
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
