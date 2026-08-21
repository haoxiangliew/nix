{ pkgs, ... }:

let
  captive-portal = pkgs.writeShellApplication {
    name = "captive-portal";
    text = builtins.readFile ./captive-portal.sh;
  };
in
{
  home.packages = [ captive-portal ];
}
