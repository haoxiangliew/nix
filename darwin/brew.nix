{ ... }:

{
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
          "betterdisplay"
          "ghostty"
          "helium-browser"
          "keyboardcleantool"
          "middleclick"
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
