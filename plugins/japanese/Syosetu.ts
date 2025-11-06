import { CheerioAPI, load as loadCheerio } from 'cheerio';
import { fetchText } from '@/lib/fetch';
import { Plugin } from '@/types/plugin';
import { defaultCover } from '@libs/defaultCover';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { NovelStatus } from '@libs/novelStatus';

class Syosetu implements Plugin.PluginBase {
  id = 'yomou.syosetu';
  name = 'Syosetu';
  icon = 'src/jp/syosetu/icon.png';
  site = 'https://yomou.syosetu.com/';
  novelPrefix = 'https://ncode.syosetu.com';
  version = '1.2.0';
  imageRequestInit?: Plugin.ImageRequestInit | undefined = undefined;
  webStorageUtilized?: boolean;

  searchUrl = (pagenum?: number, order?: string) => {
    return `${this.site}search.php?order=${order || 'hyoka'}${
      pagenum !== undefined
        ? `&p=${pagenum <= 1 || pagenum > 100 ? '1' : pagenum}` // check if pagenum is between 1 and 100
        : '' // if isn't don't set ?p
    }`;
  };
  async popularNovels(
    pageNo: number,
    { filters }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const getNovelsFromPage = async (pagenumber: number) => {
      // load page
      let url = this.site;

      if (!filters.genre.value) {
        url += `rank/list/type/${filters.ranking.value}_${filters.modifier.value}/?p=${pagenumber}`;
      } else {
        url += `rank/${
          filters.genre.value.length === 1 ? 'isekailist' : 'genrelist'
        }/type/${filters.ranking.value}_${filters.genre.value}${
          filters.modifier.value === 'total' ? '' : `_${filters.modifier.value}`
        }/?p=${pagenumber}`;
      }
      const html = await fetchText(url);
      const loadedCheerio = loadCheerio(html);

      if (parseInt(loadedCheerio('.is-current').html() || '1') !== pagenumber)
        return [];

      const novels: Plugin.NovelItem[] = [];
      loadedCheerio('.c-card').each((_, e) => {
        const anchor = loadedCheerio(e).find('.p-ranklist-item__title a');
        const url = anchor.attr('href');
        if (!url) return;
        const name = anchor.text();
        const novel: Plugin.NovelItem = {
          path: url.replace(this.novelPrefix, ''),
          name,
          cover: defaultCover,
        };
        novels.push(novel);
      });
      return novels;
    };
    const novels = await getNovelsFromPage(pageNo);
    return novels;
  }
  private parseChaptersFromPage(
    loadedCheerio: CheerioAPI,
  ): Plugin.ChapterItem[] {
    const chapters: Plugin.ChapterItem[] = [];

    loadedCheerio('.p-eplist__sublist').each((_, element) => {
      const chapterLink = loadedCheerio(element).find('a');
      const chapterUrl = chapterLink.attr('href');
      const chapterName = chapterLink.text().trim();
      const releaseDate = loadedCheerio(element)
        .find('.p-eplist__update')
        .text()
        .trim()
        .split(' ')[0]
        .replace(/\//g, '-');

      if (chapterUrl) {
        chapters.push({
          name: chapterName,
          releaseTime: releaseDate,
          path: chapterUrl.replace(this.novelPrefix, ''),
        });
      }
    });

    return chapters;
  }

  private async fetchNovelMetadata(novelPath: string): Promise<{
    name: string;
    author: string;
    summary: string;
    genres: string;
    isShortStory: boolean;
    status: string;
  }> {
    const infotopUrl = `${this.novelPrefix}/novelview/infotop/ncode${novelPath}`;
    const infotopBody = await fetchText(infotopUrl);
    const infotopCheerio = loadCheerio(infotopBody);

    // Parse basic info
    const name = infotopCheerio('.p-infotop-title a').text().trim();
    let author = '';
    let summary = '';
    let genres = '';

    // Parse data fields
    infotopCheerio('.p-infotop-data dt').each((_, dt) => {
      const title = infotopCheerio(dt).text().trim();
      const value = infotopCheerio(dt).next('dd');

      if (title === '作者名') {
        author = value.text().trim();
      } else if (title === 'あらすじ') {
        summary = value.text().trim();
      } else if (title === 'キーワード') {
        genres = value.text().trim().replace(/\s+/g, ',');
      }
    });

    // Check type (short story or serialized)
    const typeText = infotopCheerio('.p-infotop-type__type').text().trim();
    const isShortStory = typeText === '短編';

    // Parse status
    let status: string = NovelStatus.Unknown;
    if (typeText.indexOf('連載中') !== -1) {
      status = NovelStatus.Ongoing;
    } else if (typeText.indexOf('完結済') !== -1 || isShortStory) {
      status = NovelStatus.Completed;
    }

    return { name, author, summary, genres, isShortStory, status };
  }

  private async fetchSerializedChapters(
    novelPath: string,
  ): Promise<Plugin.ChapterItem[]> {
    const novelBody = await fetchText(this.novelPrefix + novelPath);
    const novelCheerio = loadCheerio(novelBody);

    const chapters: Plugin.ChapterItem[] = [];

    // Get last page URL first
    const lastPageLink = novelCheerio('.c-pager__item--last').attr('href');

    if (!lastPageLink) {
      // If no pagination, just parse chapters from the current page
      return this.parseChaptersFromPage(novelCheerio);
    } else {
      const lastPageMatch = lastPageLink.match(/\?p=(\d+)/);
      const totalPages = lastPageMatch ? parseInt(lastPageMatch[1]) : 1;

      // Fetch all pages in parallel for better performance
      const pagePromises = Array.from({ length: totalPages }, (_, i) =>
        fetchText(`${this.novelPrefix}${novelPath}?p=${i + 1}`),
      );

      const pageResults = await Promise.all(pagePromises);

      // Process each page's chapters
      pageResults.forEach((pageBody: string) => {
        const pageCheerio = loadCheerio(pageBody);
        const pageChapters = this.parseChaptersFromPage(pageCheerio);
        chapters.push(...pageChapters);
      });

      return chapters;
    }
  }
  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    // Fetch metadata from infotop page
    const metadata = await this.fetchNovelMetadata(novelPath);

    // Create novel object with metadata
    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: metadata.name,
      author: metadata.author,
      summary: metadata.summary,
      status: metadata.status,
      artist: '',
      cover: defaultCover,
      chapters: [],
      genres: metadata.genres,
    };

    // Handle short story vs serialized novel
    if (metadata.isShortStory) {
      // Short story - create single chapter
      novel.chapters = [
        {
          name: metadata.name,
          path: novelPath,
          releaseTime: '',
        },
      ];
    } else {
      // Serialized novel - fetch chapter list
      novel.chapters = await this.fetchSerializedChapters(novelPath);
    }

    return novel;
  }
  async parseChapter(chapterPath: string): Promise<string> {
    const body = await fetchText(this.novelPrefix + chapterPath);
    const cheerioQuery = loadCheerio(body);

    // Get the chapter title
    const chapterTitle = cheerioQuery('.p-novel__title').html() || '';

    // Get the chapter content, excluding preface and afterword
    const chapterContent: string[] = [];
    cheerioQuery('.p-novel__body .p-novel__text').each((_, element) => {
      const className = cheerioQuery(element).attr('class') || '';
      // Skip elements with p-novel__text--preface or p-novel__text--afterword
      if (
        className.indexOf('p-novel__text--preface') === -1 &&
        className.indexOf('p-novel__text--afterword') === -1
      ) {
        const html = cheerioQuery(element).html();
        if (html) {
          chapterContent.push(html);
        }
      }
    });

    // Combine title and content with proper HTML structure
    const chapterText = `
    <div>
      <h1>${chapterTitle}</h1>
    </div>
    <p><br><br></p>
    ${chapterContent.join('')}`;
    return chapterText;
  }
  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const url = this.searchUrl(pageNo) + `&word=${searchTerm}`;
    const body = await fetchText(url);
    const cheerioQuery = loadCheerio(body);

    const novels: Plugin.NovelItem[] = [];
    cheerioQuery('.searchkekka_box').each((_, e) => {
      const novelDIV = cheerioQuery(e).find('.novel_h');
      const novelA = novelDIV.children()[0];
      const novelPath = novelA.attribs.href.replace(this.novelPrefix, '');
      if (novelPath) {
        novels.push({
          name: novelDIV.text(),
          path: novelPath,
          cover: defaultCover,
        });
      }
    });

    return novels;
  }

  resolveUrl(path: string): string {
    return this.novelPrefix + path;
  }
  filters = {
    ranking: {
      type: FilterTypes.Picker,
      label: 'Ranked by',
      options: [
        { label: '日間', value: 'daily' },
        { label: '週間', value: 'weekly' },
        { label: '月間', value: 'monthly' },
        { label: '四半期', value: 'quarter' },
        { label: '年間', value: 'yearly' },
        { label: '累計', value: 'total' },
      ],
      value: 'total',
    },
    genre: {
      type: FilterTypes.Picker,
      label: 'Ranking Genre',
      options: [
        { label: '総ジャンル', value: '' },
        { label: '異世界転生/転移〔恋愛〕〕', value: '1' },
        { label: '異世界転生/転移〔ファンタジー〕', value: '2' },
        { label: '異世界転生/転移〔文芸・SF・その他〕', value: 'o' },
        { label: '異世界〔恋愛〕', value: '101' },
        { label: '現実世界〔恋愛〕', value: '102' },
        { label: 'ハイファンタジー〔ファンタジー〕', value: '201' },
        { label: 'ローファンタジー〔ファンタジー〕', value: '202' },
        { label: '純文学〔文芸〕', value: '301' },
        { label: 'ヒューマンドラマ〔文芸〕', value: '302' },
        { label: '歴史〔文芸〕', value: '303' },
        { label: '推理〔文芸〕', value: '304' },
        { label: 'ホラー〔文芸〕', value: '305' },
        { label: 'アクション〔文芸〕', value: '306' },
        { label: 'コメディー〔文芸〕', value: '307' },
        { label: 'VRゲーム〔SF〕', value: '401' },
        { label: '宇宙〔SF〕', value: '402' },
        { label: '空想科学〔SF〕', value: '403' },
        { label: 'パニック〔SF〕', value: '404' },
        { label: '童話〔その他〕', value: '9901' },
        { label: '詩〔その他〕', value: '9902' },
        { label: 'エッセイ〔その他〕', value: '9903' },
        { label: 'その他〔その他〕', value: '9999' },
      ],
      value: '',
    },
    modifier: {
      type: FilterTypes.Picker,
      label: 'Modifier',
      options: [
        { label: 'すべて', value: 'total' },
        { label: '連載中', value: 'r' },
        { label: '完結済', value: 'er' },
        { label: '短編', value: 't' },
      ],
      value: 'total',
    },
  } satisfies Filters;
}

export default new Syosetu();
