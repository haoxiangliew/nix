{ ... }:

{
  system = {
    primaryUser = "haoxiangliew";
    stateVersion = 7;
  };
  users.users.haoxiangliew.home = "/Users/haoxiangliew";
  home-manager.users.haoxiangliew = {
    home.stateVersion = "26.05";
  };

  homebrew.casks =
    map
      (name: {
        inherit name;
        greedy = true;
      })
      [
        "slack"
      ];
}
