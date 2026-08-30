{ config, ... }:

{
  manual.manpages.enable = false;

  home.file.".hushlogin".text = "";

  hx.onePassword = {
    agentSocket = "${config.home.homeDirectory}/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock";
    sshSignProgram = "/Applications/1Password.app/Contents/MacOS/op-ssh-sign";
  };

  programs = {
    ghostty = {
      package = null;
      settings.font-size = 12;
    };
    lazydocker = {
      enable = true;
      settings = {
        gui.containerStatusHealthStyle = "icon";
        customCommands.containers = [
          {
            name = "orb debug";
            attach = true;
            command = "orb debug {{ .Container.Name }}";
          }
        ];
      };
    };
    man.generateCaches = false;
  };
}
