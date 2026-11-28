{
  config,
  lib,
  pkgs,
  ...
}:

let
  inherit (config.hx.onePassword) agentSocket;
  signingPublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKEjsLY81zHifM54Cpr+VMiTqQssGB7C1iDWgW0maUWf";
  allowedSigners = pkgs.writeText "git-allowed-signers" ''
    haoxiangliew@gmail.com ${signingPublicKey}
  '';

  # Tailscale deletes a forwarded socket when its SSH session ends, so `-S`
  # fails on a stale link.
  forwardedAgent = "${config.home.homeDirectory}/.ssh/forwarded-agent.sock";

  # Exits 0 if nobody here can approve a prompt, 1 if someone can, and 2 on
  # error. On macOS, awake turns the display off when the lid closes, which
  # locks the screen, so there is no lid check.
  nobodyAtConsole =
    if pkgs.stdenv.isDarwin then
      ''
        users=$(/usr/sbin/ioreg -n Root -d1 -a | /usr/bin/plutil -extract IOConsoleUsers json -o - -) || {
          echo "ssh-agent-choice: couldn't read the console users from ioreg" >&2
          exit 2
        }
        ${lib.getExe pkgs.jq} -e --arg user ${lib.escapeShellArg config.home.username} \
          'any(.[]; .kCGSSessionUserNameKey == $user and .kCGSSessionOnConsoleKey and .CGSSessionScreenIsLocked != true) | not' \
          <<<"$users" >/dev/null
      ''
    else
      ''
        session=$(/usr/bin/loginctl show-user ${lib.escapeShellArg config.home.username} -p Display --value) || exit 2
        [[ -n $session ]] || exit 0
        props=$(/usr/bin/loginctl show-session "$session" -p Type -p Active -p LockedHint) || exit 2
        declare -A prop
        while IFS='=' read -r key value; do
          prop[$key]=$value
        done <<<"$props"
        [[ ''${prop[Type]-} == wayland || ''${prop[Type]-} == x11 ]] || exit 0
        for key in Active LockedHint; do
          [[ ''${prop[$key]-} == yes || ''${prop[$key]-} == no ]] || {
            echo "ssh-agent-choice: unexpected $key ''${prop[$key]-}" >&2
            exit 2
          }
        done
        [[ ''${prop[Active]} == no || ''${prop[LockedHint]} == yes ]] && exit 0
        lid=$(/usr/bin/busctl get-property org.freedesktop.login1 /org/freedesktop/login1 \
          org.freedesktop.login1.Manager LidClosed Docked) || exit 2
        [[ $lid == $'b true\nb false' ]] && exit 0
        exit 1
      '';

  # A local terminal, unlike a Rex pane, means someone is here.
  agentChoice = pkgs.writeShellScript "ssh-agent-choice" ''
    set -o pipefail
    choice=local socket=${lib.escapeShellArg agentSocket}
    if [[ -n ''${SSH_CONNECTION-} && -S ''${SSH_AUTH_SOCK-} ]]; then
      choice=session socket=$SSH_AUTH_SOCK
    elif [[ ''${1-} == session ]]; then
      exit 1
    elif [[ -n ''${REX_BLOCK-} && -S ${lib.escapeShellArg forwardedAgent} ]]; then
      (
        ${nobodyAtConsole}
      )
      case $? in
        0) choice=forwarded socket=${lib.escapeShellArg forwardedAgent} ;;
        1) ;;
        *) choice=error ;;
      esac
    fi
    if (($#)); then
      [[ $1 == "$choice" ]]
    elif [[ $choice == error ]]; then
      exit 2
    else
      printf '%s\n' "$socket"
    fi
  '';

  # op-ssh-sign ignores SSH_AUTH_SOCK and always asks the local 1Password.
  agentSigner = pkgs.writeShellScript "ssh-keygen-agent" ''
    socket=$(${agentChoice}) || exit
    SSH_AUTH_SOCK=$socket exec ${lib.getExe' pkgs.openssh "ssh-keygen"} "$@"
  '';
in
{
  options.hx.onePassword.agentSocket = lib.mkOption {
    type = lib.types.str;
    example = "\${config.home.homeDirectory}/.1password/agent.sock";
    description = "Path to the 1Password SSH agent socket.";
  };

  config = {
    home.sessionVariablesExtra = ''
      if [ -z "''${SSH_CONNECTION:-}" ]; then
        export SSH_AUTH_SOCK=${lib.escapeShellArg agentSocket}
      fi
    '';

    # Rex panes don't inherit an SSH session's SSH_AUTH_SOCK, so they use the
    # link. Relinking at each prompt returns it to a session that is still open
    # after a newer one closes. Outside SSH, choosing before each command
    # catches a screen that locked while the prompt waited.
    programs.fish.interactiveShellInit = ''
      if set -q SSH_CONNECTION
          function __ssh_agent_relink --on-event fish_prompt
              test -S "$SSH_AUTH_SOCK"; and ln -sfn "$SSH_AUTH_SOCK" ${lib.escapeShellArg forwardedAgent}
          end
      else
          function __ssh_agent_choose --on-event fish_preexec
              set -l socket (${agentChoice}); and set -gx SSH_AUTH_SOCK $socket; or set -e SSH_AUTH_SOCK
          end
      end
    '';

    programs = {
      ssh = {
        enableDefaultConfig = false;
        settings = {
          session-agent = lib.hm.dag.entryBefore [ "forwarded-agent" ] {
            header = "Match exec \"${agentChoice} session\"";
            IdentityAgent = "SSH_AUTH_SOCK";
          };
          forwarded-agent = lib.hm.dag.entryBefore [ "local-agent" ] {
            header = "Match exec \"${agentChoice} forwarded\"";
            IdentityAgent = "\"${forwardedAgent}\"";
          };
          local-agent = {
            header = "Match exec \"${agentChoice} local\"";
            IdentityAgent = "\"${agentSocket}\"";
          };
          # A failed check leaves ssh with no agent instead of the wrong one.
          "*".IdentityAgent = "none";
          # Forward 1Password itself, not a forwarded agent, so two machines
          # can't send requests back and forth.
          tailscale-user.ForwardAgent = "\"${agentSocket}\"";
        };
      };
      git = {
        signing = {
          format = "ssh";
          key = signingPublicKey;
          signer = "${agentSigner}";
        };
        settings = {
          gpg.ssh.allowedSignersFile = "${allowedSigners}";
        };
      };
    };
  };
}
