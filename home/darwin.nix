{ ... }:

{
  manual.manpages.enable = false;

  home.file.".hushlogin".text = "";

  programs = {
    ghostty = {
      package = null;
      settings.font-size = 12;
    };
    man.generateCaches = false;
  };
}
