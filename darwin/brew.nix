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
          "ghostty"
          "helium-browser"
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
