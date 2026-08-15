{
  config,
  lib,
  pkgs,
  ...
}:

let
  signingPublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKEjsLY81zHifM54Cpr+VMiTqQssGB7C1iDWgW0maUWf";
  allowedSigners = pkgs.writeText "git-allowed-signers" ''
    haoxiangliew@gmail.com ${signingPublicKey}
  '';
in
{
  options.hx.onePassword = {
    agentSocket = lib.mkOption {
      type = lib.types.str;
      example = "\${config.home.homeDirectory}/.1password/agent.sock";
      description = "Path to the 1Password SSH agent socket.";
    };

    sshSignProgram = lib.mkOption {
      type = lib.types.str;
      example = "/opt/1Password/op-ssh-sign";
      description = "Path to op-ssh-sign, used to sign git commits via 1Password.";
    };
  };

  config = {
    programs = {
      ssh = {
        enableDefaultConfig = false;
        settings."*".IdentityAgent = "\"${config.hx.onePassword.agentSocket}\"";
      };
      git = {
        signing = {
          format = "ssh";
          key = signingPublicKey;
          signer = config.hx.onePassword.sshSignProgram;
          signByDefault = true;
        };
        settings = {
          gpg.ssh.allowedSignersFile = "${allowedSigners}";
        };
      };
    };
  };
}
