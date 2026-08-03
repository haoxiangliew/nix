{
  description = "haoxiangliew's nix configurations";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";

    home-manager = {
      url = "github:nix-community/home-manager/release-26.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    inputs@{
      nixpkgs,
      home-manager,
      ...
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      forEachSystem = nixpkgs.lib.genAttrs systems;

      overlays = import ./overlays.nix inputs;

      pkgsFor =
        system:
        import nixpkgs {
          inherit system;
          config.allowUnfree = true;
          overlays = builtins.attrValues overlays;
        };
    in
    {
      inherit overlays;

      formatter = forEachSystem (system: (pkgsFor system).nixfmt-tree);

      devShells = forEachSystem (
        system:
        let
          pkgs = pkgsFor system;

          flake = ''(builtins.getFlake "/var/home/haoxiangliew/Developer/nix")'';

          languages = (pkgs.formats.toml { }).generate "languages.toml" {
            language = [
              {
                name = "nix";
                auto-format = true;
                language-servers = [ "nixd" ];
              }
              {
                name = "markdown";
                auto-format = true;
                language-servers = [
                  "marksman"
                  "mpls"
                ];
              }
            ];
            language-server.nixd = {
              command = "nixd";
              args = [ "--semantic-tokens=true" ];
              config.nixd = {
                formatting.command = [ "nixfmt" ];
                nixpkgs.expr = "import ${flake}.inputs.nixpkgs { }";
                options.home-manager.expr = ''${flake}.homeConfigurations."haoxiangliew@hx-framework".options'';
              };
            };
            language-server.mpls = {
              command = "mpls";
              args = [
                "--theme"
                "dracula"
                "--browser"
                "helium"
                "--enable-emoji"
              ];
            };
          };
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.unstable.nixd
              pkgs.nixfmt
              pkgs.marksman
              pkgs.mpls
            ];
            shellHook = ''
              mkdir -p .helix
              ln -sf ${languages} .helix/languages.toml
            '';
          };
        }
      );

      homeConfigurations."haoxiangliew@hx-framework" = home-manager.lib.homeManagerConfiguration {
        pkgs = pkgsFor "x86_64-linux";
        extraSpecialArgs = { inherit inputs; };
        modules = [
          ./home
          ./home/silverblue.nix
          ./home/gnome.nix
          ./home/helix.nix
          ./home/1password.nix
        ];
      };
    };
}
