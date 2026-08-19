{ ... }:

{
  manual.manpages.enable = false;

  home.file.".hushlogin".text = "";

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
