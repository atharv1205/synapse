/**
 * Facts about the project that the landing page and the tool's chrome both show.
 * Kept in one place so publishing is a one-line change.
 */
export const SITE = {
  name: "Synapse",
  /**
   * Placeholder: the repository is not public yet. Replace with the real URL before
   * publishing; every GitHub link and the clone command read it from here.
   */
  repositoryUrl: "https://github.com/your-username/synapse",
  /** Local directory the clone command creates, derived from the URL's last segment. */
  get cloneDir(): string {
    return this.repositoryUrl.split("/").pop() ?? "synapse";
  },
};
