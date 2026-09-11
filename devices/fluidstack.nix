{ lib, ... }:

{
  system = {
    primaryUser = "hao";
    stateVersion = 7;
  };
  users.users.hao.home = "/Users/hao";

  # Endpoint-security agents on this machine (Falcon, Kandji, Code42) make
  # link/rename syscalls ~50x slower while Nessus scans run, which stalls
  # inline store optimisation.
  determinateNix.customSettings.auto-optimise-store = lib.mkForce false;
  home-manager.users.hao = {
    home.stateVersion = "26.05";
  };

  homebrew.casks =
    map
      (name: {
        inherit name;
        greedy = true;
      })
      [
        "granola"
        "slack"
      ];
}
