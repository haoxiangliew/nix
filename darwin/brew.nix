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
      map
        (name: {
          inherit name;
          greedy = true;
        })
        [
          "1password"
          "1password-cli"
          "betterdisplay"
          "ghostty"
          "helium-browser"
          "keyboardcleantool"
          "middleclick"
          "mos"
          "orbstack"
          "slack"
          "spotify"
          "tableplus"
        ];
  };
}
