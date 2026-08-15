{ ... }:

{
  # let determinate nix handle nix on darwin
  nix.enable = false;

  programs.fish.enable = true;
}
