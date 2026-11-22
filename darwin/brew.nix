{ ... }:

{

  environment.variables = {
    HOMEBREW_NO_ANALYTICS = "1";
    OLLAMA_CONTEXT_LENGTH = "524288";
  };
  homebrew = {
    enable = true;
    enableFishIntegration = true;

    onActivation = {
      autoUpdate = true;
      cleanup = "zap";
      upgrade = true;
      extraEnv = {
        HOMEBREW_AUTO_UPDATE_SECS = "0";
        HOMEBREW_NO_ANALYTICS = "1";
      };
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
          "cap"
          "ghostty"
          "helium-browser"
          "keyboardcleantool"
          "middleclick"
          "mos"
          "ollama-binary"
          "orbstack"
          "spotify"
          "superwhisper"
          "tableplus"
        ];
  };
}
