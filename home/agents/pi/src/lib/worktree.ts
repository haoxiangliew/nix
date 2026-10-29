/**
 * Git worktree parameters and messages shared by the herdr and Rex agent tools.
 */

import { Type } from "typebox";

import { tildify } from "./paths.ts";

export const BaseParam = Type.Optional(
  Type.String({
    description:
      "Ref a new branch starts from, such as `origin/main`. Default the checkout's HEAD.",
  }),
);

export const PathParam = Type.Optional(
  Type.String({ description: "An existing worktree to open, instead of `branch` and `base`." }),
);

export const RepoCwdParam = Type.Optional(
  Type.String({
    description:
      "Any directory in the repository, including another worktree. Default your own directory.",
  }),
);

export const RemoveParams = Type.Object({
  branch: Type.Optional(Type.String({ description: "Branch of the worktree to remove" })),
  path: Type.Optional(Type.String({ description: "Path of the worktree to remove" })),
  cwd: RepoCwdParam,
  force: Type.Optional(
    Type.Boolean({
      description: "Discard the worktree's uncommitted changes. Only when the user says to.",
    }),
  ),
});

export function describeWorktree({ path, branch }: { path: string; branch?: string }): string {
  return `worktree ${tildify(path)}${branch === undefined ? "" : ` on \`${branch}\``}`;
}

/** Refuses worktree arguments for an agent that isn't placed in a worktree. */
export function checkWorktreePlacement(params: {
  placement?: string;
  branch?: string;
  base?: string;
  path?: string;
}): void {
  const asksWorktree =
    params.branch !== undefined || params.base !== undefined || params.path !== undefined;

  if (params.placement !== "worktree" && asksWorktree) {
    throw new Error('`branch`, `base`, and `path` need `placement: "worktree"`.');
  }
}
