{ ... }:

{
  system = {
    primaryUser = "hao";
    stateVersion = 7;
  };
  users.users.hao.home = "/Users/hao";
  home-manager.users.hao = {
    home.stateVersion = "26.05";

    # fluidstack already has 1Password installed via MDM
    hx.onePassword = {
      agentSocket = "/Users/hao/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock";
      sshSignProgram = "/Applications/1Password.app/Contents/MacOS/op-ssh-sign";
    };
  };

  homebrew.casks = map (name: {
    inherit name;
    greedy = true;
  }) [ "granola" ];
}
