import axios from "axios";
import * as cheerio from "cheerio";
import { isServer } from "solid-js/web";
import { parse } from "yaml";
import type { Book, TocEntry } from "./store";

export interface BookQuery {
  html_url: string;
  code_url: string;
  release: string;
  toc_path: string;
}

async function makeDownloadUrl(
  code_url: string,
  release: string,
  path: string,
): Promise<string> {
  // Output should be like:
  // * https://github.com/TeachBooks/manual/raw/refs/tags/v1.1.1/book/intro.md
  // * https://gitlab.tudelft.nl/interactivetextbooks-citg/risk-and-reliability/-/raw/v0.1/book/intro.md
  // fetch does not like redirects on github due to invalid cors in redirect response
  // so use direct link
  // https://raw.githubusercontent.com/TeachBooks/HOS-workbook/refs/heads/main/book/_toc.yml
  //                https://github.com/TeachBooks/HOS-workbook/raw/refs/heads/main/book/_toc.yml

  if (code_url.includes("github.com")) {
    // Assume `release` is a tag first. Try fetch, if this fails: assume it's a branch
    const toc_path_tag = `${code_url}/refs/tags/${release}/${path}`.replace(
      "github.com",
      "raw.githubusercontent.com",
    );
    const response = await fetch(toc_path_tag);
    if (!response.ok) {
      const u = `${code_url}/refs/heads/${release}/${path}`;
      const toc_path_branch = u.replace(
        "github.com",
        "raw.githubusercontent.com",
      );
      return toc_path_branch;
    }
    return toc_path_tag;
  }
  if (code_url.includes("gitlab")) {
    if (code_url.split("/").length > 4) {
      // Has subgroup
      return `${code_url}/raw/${release}/${path}`;
    }
    return `${code_url}/-/raw/${release}/${path}`;
  }
  throw new Error("Only GitHub and GitLab are supported");
}

interface TocYmlChapter {
  caption?: string;
  chapters?: TocYmlChapter[];
  sections?: TocYmlChapter[];
  title?: string;
  file?: string;
  url?: string;
  glob?: string;
}

interface TocYml {
  format: string;
  root: string;
  chapters?: TocYmlChapter[];
  parts?: TocYmlChapter[];
}

async function tocFromCode(query: BookQuery): Promise<TocYml> {
  const url = await makeDownloadUrl(
    query.code_url,
    query.release,
    query.toc_path,
  );
  const response = await fetch(url);
  if (!response.ok) {
    console.error(response);
    throw new Error(`Failed to fetch ${url}`);
  }
  const content = await response.text();
  // For structure of toc see https://jupyterbook.org/en/stable/structure/toc.html
  const toc = parse(content);
  // TODO apply validator
  return toc;
}

async function downloadTocAndConfigUsingGitlabApi(
  query: BookQuery,
): Promise<[TocYml, { title: string; logo: string; author: string }]> {
  const projectrepo = new URL(query.code_url).pathname.slice(1);

  const projectUrl = `https://gitlab.tudelft.nl/api/v4/projects/${encodeURIComponent(projectrepo)}`;
  const projectResponse = await fetch(projectUrl);
  if (!projectResponse.ok) {
    throw new Error(`Failed to fetch ${projectUrl}`);
  }
  const projectData = await projectResponse.json();
  const projectId = projectData.id;

  const tocContent = await fetchFileFromGitlabApi(
    projectId,
    query.toc_path,
    query,
  );
  const toc = parse(tocContent);

  const configPath = query.toc_path.replace("_toc.yml", "_config.yml");
  const configContent = await fetchFileFromGitlabApi(
    projectId,
    configPath,
    query,
  );
  const config = parse(configContent);

  const logo = deriveLogo(config, query);
  const configObj = {
    title: config.title,
    logo: logo,
    author: config.author,
  };
  return [toc, configObj];
}

async function fetchFileFromGitlabApi(
  projectId: string,
  fn: string,
  query: BookQuery,
) {
  const tocUrl = `https://gitlab.tudelft.nl/api/v4/projects/${projectId}/repository/files/${encodeURIComponent(fn)}?ref=${query.release}`;
  const tocResponse = await fetch(tocUrl);
  if (!tocResponse.ok) {
    throw new Error(`Failed to fetch ${tocUrl}`);
  }
  const tocData = await tocResponse.json();
  const tocContent = atob(tocData.content);
  return tocContent;
}

async function tocFromHtml(url: string): Promise<Array<[string, string]>> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}`);
  }
  const html = await response.text();
  let doc: Document;
  if (isServer) {
    const { JSDOM } = await import("jsdom");
    doc = new JSDOM(html).window.document;
  } else {
    const parser = new DOMParser();
    doc = parser.parseFromString(html, "text/html");
  }
  let toc: Element | null | undefined = doc.getElementById("bd-docs-nav");
  if (!toc) {
    toc = doc.getElementsByClassName("bd-docs-nav")[0];
  }
  if (!toc) {
    throw new Error("No table of contents found in HTML");
  }
  const links = Array.from(toc.querySelectorAll("a[href]"));
  return links
    .map((link) => {
      const l: [string, string] = [
        link.getAttribute("href") || "",
        link.textContent?.trim() || "",
      ];
      return l;
    })
    .filter((l) => l[0] && l[1]);
}

async function configFromCode(query: BookQuery): Promise<{
  title: string;
  logo: string;
  author: string;
}> {
  const configPath = query.toc_path.replace("_toc.yml", "_config.yml");
  const url = await makeDownloadUrl(query.code_url, query.release, configPath);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}`);
  }
  const config = parse(await response.text());
  // TODO pass through validator

  const logo = await deriveLogo(config, query);

  return {
    title: config.title,
    logo,
    author: config.author,
  };
}

async function extractLogoImageSrc(url: string): Promise<string> {
  try {
    const { data: html } = await axios.get(url);
    const $ = cheerio.load(html);
    const logoAnchor = $("a.navbar-brand.logo");
    const logoImg = logoAnchor.find("img").first();
    const src = logoImg.attr("src");

    if (src) {
      // Resolve relative URLs
      const absoluteUrl = new URL(src, url).href;
      return absoluteUrl;
    }

    return "undefined";
  } catch (error) {
    console.error("Failed to fetch or parse the page:", error);
    return "undefined";
  }
}

// biome-ignore lint/suspicious/noExplicitAny: has TODO
async function deriveLogo(config: any, query: BookQuery): Promise<string> {
  let logo: string;
  if ("logo" in config) {
    // Check if logo is already an absolute URL
    if (config.logo.startsWith("http://") || config.logo.startsWith("https://")) {
      logo = config.logo;
    } else {
      const relLogo = query.toc_path.replace("_toc.yml", config.logo);
      logo = await makeDownloadUrl(query.code_url, query.release, relLogo);
    }
  } else if ("html_static_path" in config.sphinx.config) {
    const relLogo = config.sphinx.config.html_theme_options.logo.image_light;
    const staticPath = config.sphinx.config.html_static_path[0];
    const absStaticPath = query.toc_path.replace("_toc.yml", staticPath);
    logo = await makeDownloadUrl(
      query.code_url,
      query.release,
      `${absStaticPath}/${relLogo}`,
    );
  }
  else {
    logo = "undefined"
  }
  if (logo.endsWith("undefined")) {
    logo = await extractLogoImageSrc(query.html_url);
  }
  return logo;
}

function pathWithSuffix(path: string, suffix: string) {
  const names = path.split(".");
  if (names.length > 1) {
    names.pop();
  }
  return names.join(".") + suffix;
}

function findTitle(
  file: string,
  tocHtml: Array<[string, string]>,
): [string, string] {
  const htmlPath = encodeURI(pathWithSuffix(file, ".html"));
  const searchPath = file === "#" ? file : htmlPath;
  for (const [path, title] of tocHtml) {
    if (searchPath === path) {
      return [title, path];
    }
  }

  throw new Error(`Title not found for '${file}'`);
}

function makeExternalUrl(query: BookQuery, filePath: string): string {
  // Output should be like:
  // * https://github.com/ORGANIZATION/REPOSITORY/blob/TAG/path/to/file.md
  // * https://gitlab.domainname.tld/GROUP/PROJECT/-/blob/TAG/path/to/file.md
  // * https://gitlab.domainname.tld/GROUP/SUBGROUP/PROJECT/blob/TAG/path/to/file.md
  let path = filePath;
  if (path.indexOf(".") === -1) {
    // No file extension, assume .md
    path = `${path}.md`;
  }

  path = query.toc_path.replace("_toc.yml", path);

  if (query.code_url.includes("github.com")) {
    return `${query.code_url}/blob/${query.release}/${path}`;
  }
  if (query.code_url.includes("gitlab")) {
    if (query.code_url.split("/").length > 5) {
      // Has subgroup
      return `${query.code_url}/blob/${query.release}/${path}`;
    }
    return `${query.code_url}/-/blob/${query.release}/${path}`;
  }
  throw new Error("Only GitHub and GitLab are supported");
}

function contentEntry(
  query: BookQuery,
  entry: TocYmlChapter,
  tocHtml: Array<[string, string]>,
  rootHtmlUrl: string,
): TocEntry {
  if ("file" in entry) {
    const [title, htmlUrl] = findTitle(entry.file ?? "", tocHtml);
    return {
      title: title,
      html_url: rootHtmlUrl + htmlUrl,
      external_url: makeExternalUrl(query, entry.file ?? ""),
      children: [],
    };
  }
  if ("url" in entry && "title" in entry) {
    return {
      title: entry.title ?? "",
      html_url: entry.url ?? "",
      external_url: null,
      children: [],
    };
  }
  if ("external" in entry) {
    throw new Error("External content not supported");
  }
  throw new Error(`Unknown type of content entry: ${JSON.stringify(entry)}`);
}

function mergeTocs(
  query: BookQuery,
  tocYml: TocYml,
  tocHtml: Array<[string, string]>,
): TocEntry {
  const rootPath = query.toc_path.replace("_toc.yml", tocYml.root);
  const rootFile = pathWithSuffix(tocYml.root, ".html");
  const rootHtmlUrl = query.html_url.replace(rootFile, "");
  const rootCodeUrl = makeExternalUrl(query, rootPath);

  const toc: TocEntry = {
    title: "",
    html_url: query.html_url,
    external_url: rootCodeUrl,
    children: [],
  };

  if ("parts" in tocYml) {
    for (const part of tocYml.parts ?? []) {
      const partToc: TocEntry = {
        title: part.caption || "",
        children: [],
        external_url: null,
        html_url: null,
      };
      toc.children.push(partToc);

      for (const chapter of part.chapters ?? []) {
        try {
          const chapterToc = contentEntry(query, chapter, tocHtml, rootHtmlUrl);
          partToc.children.push(chapterToc);

          if ("sections" in chapter) {
            for (const section of chapter.sections ?? []) {
              try {
                const sectionToc = contentEntry(
                  query,
                  section,
                  tocHtml,
                  rootHtmlUrl,
                );
                chapterToc.children.push(sectionToc);

                if ("sections" in section) {
                  for (const subsection of section.sections ?? []) {
                    try {
                      const subsectionToc = contentEntry(
                        query,
                        subsection,
                        tocHtml,
                        rootHtmlUrl,
                      );
                      sectionToc.children.push(subsectionToc);

                      if ("sections" in subsection) {
                        for (const subsubsection of subsection.sections ?? []) {
                          try {
                            const subsubsectionToc = contentEntry(
                              query,
                              subsubsection,
                              tocHtml,
                              rootHtmlUrl,
                            );
                            subsectionToc.children.push(subsubsectionToc);
                          } catch (error) {
                            ignoreTitleNotFoundError(error);
                          }
                        }
                      }
                    } catch (error) {
                      ignoreTitleNotFoundError(error);
                    }
                  }
                }
              } catch (error) {
                // Keep chapter as section container if section title not found
                if ("sections" in section) {
                  for (const subsection of section.sections ?? []) {
                    try {
                      const subsectionToc = contentEntry(
                        query,
                        subsection,
                        tocHtml,
                        rootHtmlUrl,
                      );
                      chapterToc.children.push(subsectionToc);
                    } catch (error) {
                      ignoreTitleNotFoundError(error);
                    }
                  }
                }
              }
            }
          }
        } catch (error) {
          ignoreTitleNotFoundError(error);
        }
      }
    }
  } else {
    for (const chapter of tocYml.chapters ?? []) {
      try {
        const chapterToc = contentEntry(query, chapter, tocHtml, rootHtmlUrl);
        toc.children.push(chapterToc);

        if ("sections" in chapter) {
          for (const section of chapter.sections ?? []) {
            try {
              const sectionToc = contentEntry(
                query,
                section,
                tocHtml,
                rootHtmlUrl,
              );
              chapterToc.children.push(sectionToc);
            } catch (error) {
              ignoreTitleNotFoundError(error);
            }
          }
        }
      } catch (error) {
        ignoreTitleNotFoundError(error);
      }
    }
  }

  return toc;
}

function ignoreTitleNotFoundError(error: unknown) {
  if (String(error).includes("Title not found")) {
    // skipit
  } else {
    throw error;
  }
}

export async function harvestBook(query: BookQuery): Promise<Book> {
  let tocYml: TocYml;
  let config: { title: string; logo: string; author: string };
  try {
    tocYml = await tocFromCode(query);
    config = await configFromCode(query);
  } catch (error) {
    if (error instanceof TypeError) {
      if (query.code_url.includes("gitlab")) {
        [tocYml, config] = await downloadTocAndConfigUsingGitlabApi(query);
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  }

  const tocHtml = await tocFromHtml(query.html_url);
  const toc = mergeTocs(query, tocYml, tocHtml);
  if (config.title === "Template" && query.code_url) {
    // biome-ignore lint/style/noNonNullAssertion: tested in if above
    config.title = query.code_url.split("/").pop()!;
  }
  if (!toc.title) {
    toc.title = config.title;
  }
  return {
    ...query,
    ...config,
    toc,
  };
}
