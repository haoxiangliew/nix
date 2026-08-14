{
  nixpkgs-unstable,
  helix,
  llm-agents,
  ...
}:

{
  unstable = final: prev: {
    unstable = import nixpkgs-unstable {
      inherit (prev.stdenv.hostPlatform) system;
      config.allowUnfree = true;
    };
  };

  helix = final: prev: {
    helix = helix.packages.${prev.stdenv.hostPlatform.system}.default;
  };

  llm-agents = final: prev: {
    llm-agents = llm-agents.packages.${prev.stdenv.hostPlatform.system};
  };
}
