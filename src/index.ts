import { html, svg, LitElement, customElement, query, property } from "lit-element";
import { classMap } from 'lit-html/directives/class-map';
import { styleMap } from 'lit-html/directives/style-map';
import { repeat } from 'lit-html/directives/repeat';
import { UUID } from 'uuid-class';

// @ts-ignore
import { StorageArea } from 'kv-storage-polyfill';

import { styles } from './styles';
import { ParamsURL, jsonFetch } from './json-request';
import { proofOfClap } from './util.js';

enum TextPlacement {
  Top = "top",
  Bottom = "bottom",
}

enum ErrorTypes {
  PaymentRequired,
  HTTPSRequired,
  CryptoRequired,
}

interface ClapData {
  url: string;
  claps: number;
  totalClaps: number;
}

const API = "http://localhost:8787";
const WEBSITE = "http://localhost:4002";
const TIMER = 2500;
const ANIM_DELAY = 250;

const storage = new StorageArea('clap-button');

const refCount = new Map<string, number>();
const fetchMap = new Map<string, Promise<{ [href: string]: { claps: number } }>>();

const withoutHash = (href: string) => {
  const parentURL = new URL(href);
  parentURL.hash = '';
  return parentURL.href;
};

const getClaps = async (url: string): Promise<{ claps: number }> => {
  const parentHref = withoutHash(url);

  let indexPromise = fetchMap.get(parentHref);
  if (!indexPromise) {
    fetchMap.set(parentHref, indexPromise = fetchMap.get(parentHref) || (async () => {
      const response = await jsonFetch(new ParamsURL('/views', { url: parentHref }, API), { method: 'POST' });
      if (response.ok && response.headers.get('Content-Type')?.includes('json')) {
        return await response.json();
      } else if (response.status === 404) {
        return {};
      } else if (response.status === 402) {
        throw response;
      }
      fetchMap.delete(parentHref);
      throw Error();
    })());
  }

  const index: { [href: string]: { claps: number } } = await indexPromise;
  return index[url] || { claps: 0 }
}

const mine = async (claps: number, url: string) => {
  const urlClass = new URL(url);
  urlClass.search = '';
  const { href } = urlClass;

  const id = new UUID();
  const nonce = await proofOfClap({ url: urlClass, claps, id });

  return { url: href, id, nonce };
}

const updateClapsApi = async (claps: number, url: string, id: UUID, nonce: number): Promise<{ claps: number }> => {
  const responseP = jsonFetch(new ParamsURL('/claps', { url }, API), {
    method: 'POST',
    body: { claps, id, nonce },
  });
  const response = await responseP;
  if (response.ok && response.headers.get('Content-Type')?.includes('json')) {
    fetchMap.delete(withoutHash(url));
    return response.clone().json();
  } else {
    throw Error();
  }
};

const arrayOfSize = (size: number) => [...new Array(size).keys()]

const formatClaps = (claps: number | null) => claps != null ? claps.toLocaleString('en') : '';

// toggle a CSS class to re-trigger animations
const toggleClass = (element: HTMLElement, ...cls: string[]) => {
  element.classList.remove(...cls);

  // Force layout reflow
  void element.offsetWidth;

  element.classList.add(...cls);
};

const debounce = (fn: (...args: any[]) => void, delay: number) => {
  let timer: NodeJS.Timeout;
  return function (...args: any[]) {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
};

@customElement('clap-button')
export class ClapButton extends LitElement {
  static styles = styles;

  el: HTMLElement = this;

  @query('.style-root') private styleRootEl!: HTMLElement;

  @property({ type: String, reflect: true, attribute: 'text-placement' }) textPlacement: TextPlacement = TextPlacement.Top;
  @property({ type: Boolean, reflect: true }) noWave: boolean = false;
  // @property({ type: Boolean, reflect: true }) useLocation: boolean = false;

  @property({ type: String, reflect: false }) url!: string;

  @property() private totalClaps: number = 0;
  @property() private loading: boolean = false;
  @property() private clapped: boolean = false;
  @property() private clicking: boolean = false;
  @property() private bufferedClaps: number = 0;
  @property() private ready: boolean = false;
  @property() private error: ErrorTypes | null = null;

  private _canonicalUrl?: string;
  private get canonicalUrl() {
    if (!this._canonicalUrl) {
      if (this.url) {
        this._canonicalUrl = new URL(this.url, this.ownerDocument.location.origin).href;
      } else {
        this._canonicalUrl = this.ownerDocument.location.href;
      }
    }
    return this._canonicalUrl
  }

  async connectedCallback() {
    super.connectedCallback();

    refCount.set(this.canonicalUrl, 1 + (refCount.get(this.canonicalUrl) || 0));

    if (this.ownerDocument.location.hostname !== 'localhost' && this.ownerDocument.location.protocol !== 'https:') {
      this.error = ErrorTypes.HTTPSRequired;
      return;
    }

    if ('crypto' in window && 'subtle' in window.crypto && 'digest' in window.crypto.subtle) { /* ok */ } else {
      this.error = ErrorTypes.CryptoRequired;
      return;
    }

    // @ts-ignore
    this.ownerDocument.documentElement.addEventListener('clapped', this.clappedCallback);

    // const themeColorEl = document.head.querySelector('meta[name=theme-color]') as HTMLMetaElement | null;
    // if (themeColorEl) {
    //   this.el.style.setProperty('--theme-color', themeColorEl.content);
    // }

    this.loading = true;
    this.clapped = await storage.get(this.canonicalUrl) != null;

    try {
      const { claps } = await getClaps(this.canonicalUrl);
      this.loading = false;
      this.ready = true;
      this.totalClaps = claps;
    } catch (err) {
      this.loading = false;
      this.ready = false;
      this.error = err.status === 402 ? ErrorTypes.PaymentRequired : null;
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    // @ts-ignore
    this.ownerDocument.documentElement.removeEventListener('clapped', this.clappedCallback);

    const parentHref = withoutHash(this.canonicalUrl);
    const cnt = refCount?.get(parentHref) || 0 - 1;
    if (cnt > 0) {
      refCount.set(parentHref, cnt);
    } else {
      refCount.delete(parentHref);
      fetchMap.delete(parentHref);
    }
  }

  private clappedCallback = ({ target, detail: { url, claps } }: CustomEvent<ClapData>) => {
    if (target !== this && url === this.canonicalUrl || withoutHash(url) === this.canonicalUrl) {
      this.clapped = true;
      this.totalClaps += claps;
      toggleClass(this.styleRootEl, "clap");
    }
  }

  render() {
    const hand = svg`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60" id="hand-svg">
        <g class="flat">
          <path d="M57.0443547 6.86206897C57.6058817 6.46227795 57.7389459 5.67962382 57.3416215 5.11431557 56.9442971 4.54900731 56.1672933 4.41483804 55.6055588 4.81504702L52.4950525 7.030721C51.9335255 7.43051202 51.8004613 8.21316614 52.1977857 8.7784744 52.4404567 9.12371996 52.8251182 9.30825496 53.2153846 9.30825496 53.4640757 9.30825496 53.7152578 9.23343783 53.9338485 9.07753396L57.0443547 6.86206897zM48.8035059 6.1414838C48.94778 6.19623824 49.0959982 6.22215256 49.2415177 6.22215256 49.7455426 6.22215256 50.2198824 5.91201672 50.4075424 5.40898642L51.7485642 1.81818182C51.9906124 1.17011494 51.664906.447021944 51.0209664.203343783 50.3772345-.0405433647 49.6587706.287774295 49.4167224.93584117L48.0757006 4.52664577C47.83386 5.17471264 48.1595664 5.89780564 48.8035059 6.1414838zM58.5931726 11.6219436C58.5846615 11.6219436 58.5761504 11.6219436 58.5674317 11.6219436L54.7579749 11.6541275C54.0702341 11.6681296 53.5240687 12.1985371 53.5379772 12.8909091 53.551678 13.5745037 54.1065621 14.1297806 54.7828855 14.1297806 54.7913966 14.1297806 54.7999077 14.1297806 54.8086265 14.1297806L58.6180833 14.0643678C59.305824 14.0501567 59.8519894 13.4934169 59.838081 12.8010449 59.8243801 12.1174504 59.269496 11.6219436 58.5931726 11.6219436z"/>
          <path d="M37.1910045 6.68944619C37.7313574 6.14566353 38.4431784 5.8737722 39.155207 5.8737722 39.967916 5.8737722 40.7808327 6.22800418 41.3380002 6.93667712 42.2214969 8.06039707 42.0666359 9.69111808 41.0600392 10.7042842L39.777765 11.9949843C39.5801407 12.1276907 39.3877061 12.2695925 39.2075193 12.430303 39.0619998 11.5985371 38.7167801 10.7954023 38.1668781 10.0961338 37.4907623 9.23636364 36.588375 8.62424242 35.5772114 8.31410658L37.1910045 6.68944619zM28.5289586 3.66394984C29.0691039 3.12016719 29.7811325 2.84827586 30.4931611 2.84827586 31.3060777 2.84848485 32.1187868 3.20271682 32.6759543 3.91138976 33.559451 5.03510972 33.40459 6.66562173 32.3979933 7.67878788L17.6760235 22.3467085 17.6276554 20.6499478C17.6149925 19.014629 16.8595779 17.554441 15.6854573 16.5945664L28.5289586 3.66394984zM.624996757 36.9889537C.491717597 36.554099.508245877 35.7327064.906400646 35.2666667L3.45579518 32.2829676C3.45662553 32.2819923 4.33763118 25.8376176 6.09881213 12.9498433 6.09881213 11.4271682 7.33624726 10.1814002 8.84873717 10.1814002 10.3612271 10.1814002 11.5988698 11.4271682 11.5988698 12.9498433L11.6704878 15.4649948C9.18191673 15.8089864 7.24428555 17.9170324 7.14921001 20.492581L4.62804751 38.9475444 3.8946373 39.8060606C3.04504924 39.4926018 2.3776139 39.1458968 1.89233128 38.7659456 1.16440735 38.1960189.758275917 37.4238085.624996757 36.9889537z"/>
          <path d="M49.6070811,36.8942529 L42.4182909,44.1316614 C36.2784454,50.3128527 29.8604313,55.2743992 24.2225349,56.5113898 C24.0512744,56.5492163 23.8901857,56.6217346 23.7511014,56.7293626 L20.5013032,59.2417973 C20.2908084,59.4045977 20.1673015,59.6181154 19.5026647,59.6181154 C18.8380279,59.6181154 13.0160695,55.8303982 10.3595306,53.2846814 C7.96626306,50.9912532 3.77432047,43.9549368 4.44453927,43.0079415 L6.99372621,40.0244514 C6.99469496,40.0233368 7.87570061,33.578962 9.63674317,20.6913271 C9.63674317,19.168652 10.8743859,17.922675 12.3868758,17.922675 C13.8993657,17.922675 15.1368008,19.168652 15.1368008,20.6913271 L15.2667512,25.2522466 C15.2883404,26.0100313 15.907577,26.5034483 16.5519317,26.5034483 C16.8662207,26.5034483 17.1867374,26.3857889 17.4464306,26.1245559 L32.0670972,11.4054336 C32.6074501,10.861442 33.3190635,10.5897597 34.0312997,10.5897597 C34.8440088,10.5897597 35.6569254,10.9439916 36.214093,11.6526646 C37.0975897,12.7763845 36.942521,14.4071055 35.9359243,15.4202717 L25.8641449,25.5598746 C25.3412294,26.0865204 25.3412294,26.9398119 25.8641449,27.4660397 C26.1288202,27.7324974 26.4757006,27.8658307 26.822581,27.8658307 C27.1694614,27.8658307 27.5165494,27.7324974 27.7810172,27.4660397 L40.7291431,14.43093 C41.2692884,13.8869383 41.9811094,13.615256 42.6933456,13.615256 C43.5060547,13.615465 44.3189713,13.969697 44.8761389,14.6783699 C45.7596356,15.8018809 45.6045669,17.4326019 44.5979702,18.445768 L31.7106677,31.4198537 C31.1806943,31.953605 31.1806943,32.8183908 31.7106677,33.3521421 C31.9718141,33.615047 32.31392,33.7464995 32.656441,33.7464995 C32.9985469,33.7464995 33.3408603,33.615047 33.6020067,33.3521421 L43.7346096,23.1515152 C44.2749625,22.6075235 44.9867835,22.3358412 45.6988121,22.3358412 C46.5115212,22.3358412 47.3244378,22.6900731 47.8816054,23.3989551 C48.7651021,24.522466 48.6100334,26.153187 47.6034367,27.1663532 L37.5667397,37.2708464 C37.0245185,37.8165099 37.0245185,38.7017764 37.5667397,39.2474399 C37.8334909,39.5161964 38.161896,39.6422153 38.4900934,39.6422153 C38.8184984,39.6422153 39.1469035,39.5161964 39.3972552,39.2639498 L45.6195133,32.999791 C46.1802099,32.4353187 46.93085,32.1368861 47.678999,32.1368861 C48.2741552,32.1368861 48.8676508,32.3258098 49.361919,32.7197492 C50.682182,33.7717868 50.7639719,35.7297806 49.6070811,36.8942529 Z"/>
        </g>
        <g class="outline">
          <path d="M57.1428763 6.63333333C57.6856856 6.24686869 57.8143144 5.49030303 57.4302341 4.94383838 57.0461538 4.39737374 56.2950502 4.26767677 55.7520401 4.65454545L52.7452174 6.79636364C52.202408 7.18282828 52.0737793 7.93939394 52.4578595 8.48585859 52.6924415 8.81959596 53.0642809 8.9979798 53.4415385 8.9979798 53.6819398 8.9979798 53.9247492 8.92565657 54.1360535 8.77494949L57.1428763 6.63333333zM49.1767224 5.93676768C49.3161873 5.98969697 49.4594649 6.01474747 49.6001338 6.01474747 50.0873579 6.01474747 50.5458863 5.71494949 50.727291 5.22868687L52.023612 1.75757576C52.257592 1.13111111 51.9427425.432121212 51.3202676.196565657 50.6979933-.0391919192 50.0034783.278181818 49.7694983.904646465L48.4731773 4.37575758C48.239398 5.00222222 48.5542475 5.70121212 49.1767224 5.93676768zM58.6400669 11.2345455C58.6318395 11.2345455 58.623612 11.2345455 58.6151839 11.2345455L54.932709 11.2656566C54.267893 11.2791919 53.7399331 11.7919192 53.7533779 12.4612121 53.7666221 13.1220202 54.30301 13.6587879 54.9567893 13.6587879 54.9650167 13.6587879 54.9732441 13.6587879 54.9816722 13.6587879L58.6641472 13.5955556C59.3289632 13.5818182 59.8569231 13.0436364 59.8434783 12.3743434 59.8302341 11.7135354 59.2938462 11.2345455 58.6400669 11.2345455zM51.2107023 29.7280808C50.5940468 29.2365657 49.8640134 28.9020202 49.0922408 28.7448485 49.1432107 28.6519192 49.1907692 28.5573737 49.2357191 28.4614141L49.7189298 27.9749495C51.5799331 26.1012121 51.7753846 23.1519192 50.1732441 21.1141414 49.4169231 20.1523232 48.3670234 19.5131313 47.2009365 19.2745455 47.284214 19.120202 47.3580602 18.9624242 47.4250836 18.8022222 48.6925084 16.9539394 48.6718395 14.469899 47.2681605 12.6844444 46.5116388 11.7220202 45.4613378 11.0808081 44.2946488 10.8426263 45.2578595 9.05959596 45.1348495 6.83737374 43.8481605 5.20121212 42.8753177 3.96383838 41.4182609 3.25393939 39.8502341 3.25393939 38.5946488 3.25393939 37.4101003 3.70565657 36.480602 4.53272727 36.3399331 3.72888889 36.0064214 2.95252525 35.4748495 2.27636364 34.501806 1.0389899 33.0447492.329292929 31.4767224.329090909 30.1141806.329090909 28.8351171.861414141 27.8753177 1.82767677L15.6666221 14.1185859 15.6200669 12.4781818C15.5985953 9.68424242 13.3340468 7.41777778 10.5537793 7.41777778 7.8238796 7.41777778 5.59143813 9.60262626 5.49110368 12.3264646L3.05377926 30.1660606 1.05050167 32.510303C-.150100334 33.9157576.751318148 36.4103164 1.05050167 37.002855 1.3496852 37.5953936 1.66593319 37.9666982 2.51271962 38.8651283 2.8050341 39.1752704 3.3712736 39.6680391 4.21143813 40.3434343 3.2935786 41.7335354 4.72327715 47.298456 9.51045561 52.4226263 15.4436869 58.7735254 20.1888963 59.9262626 21.1316388 59.9262626 21.9056187 59.9262626 22.6703679 59.6646465 23.2846154 59.189899L26.2031438 56.9337374C29.0107023 56.2660606 32.1060201 54.7492929 35.4086288 52.4226263 38.2924415 50.3907071 41.4210702 47.6832323 44.7070234 44.3749495L51.656388 37.3787879C52.681204 36.3470707 53.220602 34.9165657 53.1363211 33.4541414 53.0520401 31.9941414 52.350301 30.6361616 51.2107023 29.7280808zM37.9513043 6.46646465C38.4736455 5.94080808 39.1617391 5.6779798 39.8500334 5.6779798 40.6356522 5.6779798 41.4214716 6.02040404 41.9600669 6.70545455 42.8141137 7.79171717 42.6644147 9.36808081 41.6913712 10.3474747L40.4518395 11.5951515C40.2608027 11.7234343 40.0747826 11.8606061 39.900602 12.0159596 39.7599331 11.2119192 39.4262207 10.4355556 38.8946488 9.75959596 38.2410702 8.92848485 37.3687625 8.33676768 36.3913043 8.0369697L37.9513043 6.46646465zM29.5779933 3.54181818C30.1001338 3.01616162 30.7884281 2.75333333 31.4767224 2.75333333 32.2625418 2.75353535 33.0481605 3.0959596 33.5867559 3.7810101 34.4408027 4.86727273 34.2911037 6.44343434 33.3180602 7.42282828L19.0868227 21.6018182 19.0400669 19.9616162C19.0278261 18.3808081 18.297592 16.9692929 17.1626087 16.0414141L29.5779933 3.54181818zM2.60416353 35.7559886C2.47532701 35.335629 2.49130435 34.5416162 2.87618729 34.0911111L5.34060201 31.2068687C5.34140468 31.2059259 6.19304348 24.9763636 7.89551839 12.5181818 7.89551839 11.0462626 9.09170569 9.8420202 10.5537793 9.8420202 12.0158528 9.8420202 13.2122408 11.0462626 13.2122408 12.5181818L13.2814716 14.9494949C10.8758528 15.2820202 9.00280936 17.319798 8.91090301 19.8094949L6.47377926 37.6492929 5.76481605 38.4791919C4.9435476 38.1761817 4.2983601 37.8410335 3.82925357 37.4737474 3.12559377 36.9228183 2.73300005 36.1763482 2.60416353 35.7559886zM49.9535117 35.6644444L43.0043478 42.6606061C37.0691639 48.6357576 30.8650836 53.4319192 25.4151171 54.6276768 25.2495652 54.6642424 25.0938462 54.7343434 24.959398 54.8383838L21.8179264 57.2670707C21.6144482 57.4244444 21.4950582 57.6308449 20.8525759 57.6308449 20.2100936 57.6308449 14.5822005 53.9693849 12.0142129 51.5085254 9.70072096 49.2915447 5.64850979 42.4897722 6.29638796 41.5743434L8.76060201 38.690303C8.76153846 38.6892256 9.61317726 32.4596633 11.3155184 20.0016162 11.3155184 18.529697 12.5119064 17.3252525 13.9739799 17.3252525 15.4360535 17.3252525 16.6322408 18.529697 16.6322408 20.0016162L16.7578595 24.4105051C16.7787291 25.1430303 17.3773244 25.62 18.0002007 25.62 18.3040134 25.62 18.6138462 25.5062626 18.8648829 25.2537374L32.998194 11.0252525C33.5205351 10.4993939 34.2084281 10.2367677 34.8969231 10.2367677 35.6825418 10.2367677 36.4683612 10.5791919 37.0069565 11.2642424 37.8610033 12.3505051 37.7111037 13.9268687 36.7380602 14.9062626L27.0020067 24.7078788C26.4965217 25.2169697 26.4965217 26.0418182 27.0020067 26.5505051 27.2578595 26.8080808 27.5931773 26.9369697 27.928495 26.9369697 28.2638127 26.9369697 28.5993311 26.8080808 28.8549833 26.5505051L41.371505 13.949899C41.8936455 13.4240404 42.5817391 13.1614141 43.2702341 13.1614141 44.0558528 13.1616162 44.8416722 13.5040404 45.3802676 14.1890909 46.2343144 15.2751515 46.0844147 16.8515152 45.1113712 17.8309091L32.6536455 30.3725253C32.1413378 30.8884848 32.1413378 31.7244444 32.6536455 32.240404 32.906087 32.4945455 33.2367893 32.6216162 33.567893 32.6216162 33.8985953 32.6216162 34.2294983 32.4945455 34.4819398 32.240404L44.2767893 22.379798C44.7991304 21.8539394 45.4872241 21.5913131 46.1755184 21.5913131 46.9611371 21.5913131 47.7469565 21.9337374 48.2855518 22.6189899 49.1395987 23.7050505 48.989699 25.2814141 48.0166555 26.2608081L38.3145151 36.0284848C37.7903679 36.5559596 37.7903679 37.4117172 38.3145151 37.9391919 38.5723746 38.1989899 38.8898328 38.3208081 39.2070903 38.3208081 39.5245485 38.3208081 39.8420067 38.1989899 40.0840134 37.9551515L46.0988629 31.899798C46.6408696 31.3541414 47.3664883 31.0656566 48.089699 31.0656566 48.6650167 31.0656566 49.2387291 31.2482828 49.7165217 31.6290909 50.9927759 32.6460606 51.0718395 34.5387879 49.9535117 35.6644444z"/>
        </g>
      </svg>`;

    const circle = svg`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" id="countdown-svg">
      <g class="countdown">
        <circle cx="50" cy="50" r="49"/>
      </g>
    </svg>
    `;

    const x = this.bufferedClaps;
    const n = 5 + x;
    const BASE_MAX_DELAY = 300;
    const maxDelay = BASE_MAX_DELAY * (1 - Math.E ** (-x / 15));
    const sparkle = svg`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -10 20 20">
        <g class="sparkle">
          ${repeat(arrayOfSize(n), i => i, i => svg`<g style=${styleMap({ transform: `rotate(${Math.floor(360 / n * i)}deg) translateX(10px)` })}>
            <circle style=${styleMap({ animationDelay: `${Math.floor(Math.random() * maxDelay)}ms` })} cx="0" cy="0" r="1"/>
          </g>`)}
        </g>
      </svg>`;

    return html`
      <div 
        class=${classMap({
      'style-root': true,
      'loading': this.loading,
      'clapped': this.clapped,
      'no-shockwave': this.noWave || !this.ready,
    })}
        style=${styleMap({
      ...this.error ? { '--clap-button-color': 'indianred' } : {}
    })}
      >
        <div class="shockwave"></div>
        <div class=${classMap({
      'count-container': true,
      'container-top': this.textPlacement === TextPlacement.Top,
      'container-bottom': this.textPlacement === TextPlacement.Bottom,
    })}>
          <div class="count">
            ${this.clicking ? '+' : ''}${this.ready ? formatClaps(this.totalClaps) : ''}
            ${this.error === ErrorTypes.PaymentRequired ? html`<a class="error" href="${WEBSITE}">Payment required</a>` : null}
            ${this.error === ErrorTypes.HTTPSRequired ? html`<span class="error">HTTPS required</span>` : null}
            ${this.error === ErrorTypes.CryptoRequired ? html`<span class="error">Crypto required</span>` : null}
          </div>
        </div>
        ${hand}
        ${sparkle}
        ${circle}
        <button
          ?disabled=${this.loading || !this.ready}
          @mousedown=${this.loading || !this.ready ? null : this.clickCallback}
          @touchstart=${this.loading || !this.ready ? null : this.clickCallback}
        ></button>
      </div>
      `;
  }

  private updateClaps = debounce(async () => {
    const claps = this.bufferedClaps;
    this.bufferedClaps = 0;
    this.loading = true;
    const { url, id, nonce } = await mine(claps, this.canonicalUrl);
    const { claps: totalClaps } = await updateClapsApi(claps, url, id, nonce);

    this.loading = false;
    this.clicking = false;
    this.styleRootEl.classList.remove('ticking');
    toggleClass(this.styleRootEl, "clap");

    this.dispatchEvent(new CustomEvent<ClapData>("clapped", {
      bubbles: true,
      detail: { claps, totalClaps, url },
    }));

    setTimeout(() => { this.totalClaps = totalClaps }, ANIM_DELAY);

    const data = await storage.get(url) || { claps: 0 };
    await storage.set(url, { ...data, claps: data.claps + claps });
  }, TIMER); // MAYBE: Replace with animation finish event!?

  private clickCallback = (event: MouseEvent) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();

    this.clapped = true;
    this.clicking = true;
    this.bufferedClaps++;

    toggleClass(this.styleRootEl, "clap", "ticking");

    this.updateClaps();

    this.totalClaps = this.bufferedClaps
  }
}
