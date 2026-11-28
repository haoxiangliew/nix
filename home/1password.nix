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

  # Only Rex panes use the forwarded agent, because a local terminal means
  # someone is at this machine.
  agentChoice = pkgs.writeShellScript "ssh-agent-choice" ''
    if [[ -n ''${SSH_CONNECTION-} && -S ''${SSH_AUTH_SOCK-} ]]; then
      choice=session socket=$SSH_AUTH_SOCK
    elif [[ -n ''${REX_BLOCK-} && -S ${lib.escapeShellArg forwardedAgent} ]]; then
      choice=forwarded socket=${lib.escapeShellArg forwardedAgent}
    else
      choice=local socket=${lib.escapeShellArg agentSocket}
    fi
    if (($#)); then
      [[ $1 == "$choice" ]]
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
    # after a newer one closes.
    programs.fish.interactiveShellInit = ''
      function __ssh_agent --on-event fish_prompt
          if set -q SSH_CONNECTION
              test -S "$SSH_AUTH_SOCK"; and ln -sfn "$SSH_AUTH_SOCK" ${lib.escapeShellArg forwardedAgent}
          else
              set -gx SSH_AUTH_SOCK (${agentChoice})
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
          forwarded-agent = {
            header = "Match exec \"${agentChoice} forwarded\"";
            IdentityAgent = "\"${forwardedAgent}\"";
          };
          "*".IdentityAgent = "\"${agentSocket}\"";
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
