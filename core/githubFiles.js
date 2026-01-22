const OWNER = "lukeinthecity";
const REPO = "value-steward";

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "value-steward-agent",
  };
}

export async function loadJsonFile({ token, path, defaultValue }) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;

  const res = await fetch(url, { headers: githubHeaders(token) });

  if (res.status === 404) {
    return { content: defaultValue, sha: null };
  }

  if (!res.ok) {
    throw new Error(`Error loading ${path}: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const decoded = JSON.parse(
    Buffer.from(data.content, "base64").toString("utf8")
  );

  return { content: decoded, sha: data.sha };
}

export async function saveJsonFile({ token, path, content, sha, message }) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;

  const encoded = Buffer.from(JSON.stringify(content, null, 2)).toString("base64");

  const body = {
    message,
    content: encoded,
    ...(sha ? { sha } : {}),
  };

  const res = await fetch(url, {
    method: "PUT",
    headers: githubHeaders(token),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Error saving ${path}: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return { sha: data.content.sha, commitSha: data.commit.sha };
}

export async function appendJsonl({ token, path, entry }) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;

  let sha = null;
  let existing = "";

  const getRes = await fetch(url, { headers: githubHeaders(token) });
  if (getRes.status === 200) {
    const data = await getRes.json();
    sha = data.sha;
    existing = Buffer.from(data.content, "base64").toString("utf8");
  } else if (getRes.status !== 404) {
    throw new Error(`Error reading ${path}: ${getRes.status} ${await getRes.text()}`);
  }

  const line = JSON.stringify(entry) + "\n";
  const newContent = existing + line;
  const encoded = Buffer.from(newContent).toString("base64");

  const body = {
    message: `Log tick at ${entry.ranAt}`,
    content: encoded,
    ...(sha ? { sha } : {}),
  };

  const putRes = await fetch(url, {
    method: "PUT",
    headers: githubHeaders(token),
    body: JSON.stringify(body),
  });

  if (!putRes.ok) {
    throw new Error(`Error writing ${path}: ${putRes.status} ${await putRes.text()}`);
  }

  const data = await putRes.json();
  return { sha: data.content.sha, commitSha: data.commit.sha };
}
