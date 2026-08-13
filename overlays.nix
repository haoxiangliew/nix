{ nixpkgs-unstable, llm-agents, ... }:

{
  unstable = final: prev: {
    unstable = import nixpkgs-unstable {
      inherit (prev.stdenv.hostPlatform) system;
      config.allowUnfree = true;
    };
  };

  llm-agents = final: prev: {
    llm-agents = llm-agents.packages.${prev.stdenv.hostPlatform.system};
  };
}
