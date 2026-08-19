{ ... }:

{

  environment.variables = {
    HOMEBREW_NO_ANALYTICS = "1";
  };
  homebrew = {
    enable = true;
    enableFishIntegration = true;

    onActivation = {
      autoUpdate = true;
      cleanup = "zap";
      upgrade = true;
    };

    brews = [ ];

    casks =
      let
        packages = [
          "1password"
          "1password-cli"
          "betterdisplay"
          "ghostty"
          "granola"
          "helium-browser"
          "keyboardcleantool"
          "middleclick"
          "mos"
          "orbstack"
          "slack"
          "spotify"
        ];
      in
      (map (
        pkg:
        if builtins.isString pkg then
          {
            name = pkg;
            greedy = true;
          }
        else
          pkg
      ) packages)
      ++ [ ];
  };
}
