inputs:

rec {
  helix = final: prev: {
    helix = inputs.helix.packages.${prev.stdenv.hostPlatform.system}.default;
  };

  llm-agents = final: prev: {
    llm-agents = inputs.llm-agents.packages.${prev.stdenv.hostPlatform.system};
  };

  unstable = final: prev: {
    unstable = import inputs.nixpkgs-unstable {
      inherit (prev.stdenv.hostPlatform) system;
      config.allowUnfree = true;
      overlays = [
        helix
        llm-agents
      ];
    };
  };
}
