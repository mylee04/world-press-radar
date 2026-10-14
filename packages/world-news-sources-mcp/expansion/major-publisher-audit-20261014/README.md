# 국가별 대표 언론사 등록 공백 조사 — 2026-10-14

기존 World Press Radar의 **73개국, 5,437개 등록행**을 국가별 대표 매체 **387개 항목**과 대조했다. 선정 목록에서 **미등록 81개, 비활성 등록만 있는 매체 11개, 다른 국가에 등록된 매체 1개, 별도 검토 5개**가 확인됐다. 활성 등록으로 대조된 항목은 289개다. 같은 매체를 여러 국가의 기준 항목으로 선정할 수 있으므로 글로벌 고유 회사 수와 다르다. 이 숫자의 분모는 이번 선정 목록이며, 전체 주요 언론사 수나 보급률이 아니다.

## 조사 기준과 범위

- 국가마다 4–6개의 종합신문·공영/주요 방송·통신사·경제지를 기관 역할과 편집 범위로 선정했다. 발행 부수나 시청률 순위를 새로 추정하지 않았다. [Reuters Institute Digital News Report 2026의 국가별 자료](https://reutersinstitute.politics.ox.ac.uk/digital-news-report/2026/country-and-market-data)는 해당 시장의 배경 자료이며, 그 조사에 없는 국가도 기관 공식 자료로 살폈다.
- 미등록·비활성·검토 후보에는 공식 홈페이지, 기관 소개, 소유사 브랜드 소개 또는 공식 사이트의 검색 수록 자료를 연결했다. 조회 제한과 확인 수준은 각 지역 JSON에 남겼다. 모든 기존 활성 매체의 정체성을 이번에 다시 온라인 검증했다는 뜻은 아니다.
- 이름·언어별 별칭·공식 도메인·해당 언론사에 귀속된 피드 경로를 대조했다. 같은 이름의 타국 신문, 계열사의 다른 매체, 일반적인 Yahoo/Feedburner 호스트를 일괄 같은 언론사로 세지 않았다. 회사 본사와 편집 대상 국가가 다를 수 있어 다른 국가 등록은 별도 검토한다.
- **활성 등록은 작동하는 수집 주소를 보장하지 않는다.** 공식 홈페이지 접속 성공도 RSS·사이트맵 성공과 다르다. 후보 주소가 null이면 아직 검증하지 않았다는 뜻이다.
- 등록행은 회사 수·고유 언론사 수·주소 수와 다르다. 한 매체에 여러 섹션/언어 등록이 있고, 한 행에 RSS와 사이트맵이 함께 있을 수 있다.

## 매일 검사 일정

[서버의 실제 systemd 사용자 타이머](schedule-verification.json)를 2026-10-14T05:24:49.866873+00:00에 읽기 전용으로 확인했다. 타이머는 enabled/active이고 **매일 UTC 03:00, 한국 시간 정오**에 실행한다. 다음 예정은 **2026-10-15 03:00 UTC**다.

활성 RSS·사이트맵 주소 전체를 당일 대상으로 선정하는 daily_all_active 정책이다. 마지막 확인 회차는 5,458개 중 5,457개를 실제 검사했으며, Yomiuri의 한 주소는 같은 호스트의 HTTP 429 대기 때문에 다음 시점으로 유예됐다. 병렬 6개, 같은 호스트 간격 2초, 제한된 타임아웃·재시도 및 Retry-After를 유지한다. 신규 URL 0건만으로 장애로 판정하지 않는다.

마지막 서비스는 수집 뒤 기존 고정 등록 수를 기대한 smoke 검증 때문에 실패 상태로 끝났다. 동적 등록 수 검증 수정은 설치돼 있지만 **다음 정기 실행의 최종 성공은 아직 확인할 수 없다**. 이번 조사는 작업을 재시작하거나 중복 수집을 실행하지 않았다.

## 먼저 보강할 국가

활성 등록행이 10개 미만이고 이번 대표 매체 목록에 미등록 후보가 있는 국가다. 이 우선순위는 수집 공백을 기준으로 하며 언론사의 영향력 순위가 아니다.

| 국가 | 현재 활성 등록행 | 미등록 대표 후보 |
| --- | ---: | --- |
| 요르단 (JO) | 1 | [Jordan News Agency / Petra](https://www.petra.gov.jo/); [Al Rai Jordan](https://www.alrai.com/); [Ad-Dustour](https://www.addustour.com/); [The Jordan Times](https://www.jordantimes.com/); [Roya News](https://www.royanews.tv/) |
| 쿠웨이트 (KW) | 0 | [Kuwait News Agency / KUNA](https://www.kuna.net.kw/); [Al Qabas](https://www.alqabas.com/); [Al Rai Kuwait](https://www.alraimedia.com/); [Al Anba](https://www.alanba.com.kw/); [Al Jarida](https://www.aljarida.com/); [Kuwait Times](https://www.kuwaittimes.com/) |
| 바레인 (BH) | 1 | [Bahrain News Agency / BNA](https://www.bna.bh/); [Al Ayam](https://www.alayam.com/); [Akhbar Al Khaleej](https://www.akhbar-alkhaleej.com/); [Gulf Daily News / Gulf Digital News](https://www.gdnonline.com/); [The Daily Tribune / News of Bahrain](https://www.newsofbahrain.com/) |
| 오만 (OM) | 7 | [Oman News Agency / ONA](https://www.omannews.gov.om/); [Al Watan Oman](https://www.alwatan.om/) |
| 몽골 (MN) | 4 | [MONTSAME](https://montsame.mn/en/); [Mongolian National Broadcaster / MNB](https://www.mnb.mn/); [Unuudur](https://www.unuudur.mn/) |
| 파키스탄 (PK) | 2 | [Associated Press of Pakistan](https://www.app.com.pk/); [Business Recorder](https://www.brecorder.com/); [PTV News](https://ptv.com.pk/) |

## 73개국 대조표

‘—’는 **이번 선정 목록에서 해당 유형의 공백을 찾지 않았다는 뜻**이다. 해당 국가의 모든 주요 언론사를 확보했다는 뜻은 아니다. 비활성 매체는 새 언론사로 추가하지 말고 기존 주소와 비활성 사유부터 검토해야 한다.

| 국가 | 등록행 활성/전체 | 선정 대표 매체 | 미등록 후보 | 비활성·국가 분류·별도 검토 |
| --- | ---: | ---: | --- | --- |
| 미국 (US) | 237/240 | 6 | — | — |
| 중국 (CN) | 55/101 | 6 | [CCTV News](https://news.cctv.com/) | [Caixin](https://www.caixinglobal.com/) (비활성); [China Daily](https://www.chinadaily.com.cn/) (비활성); [Xinhua](https://english.news.cn/) (비활성) |
| 일본 (JP) | 126/150 | 5 | — | — |
| 독일 (DE) | 140/143 | 5 | [Deutsche Presse-Agentur (dpa)](https://www.dpa.com/) | — |
| 인도 (IN) | 44/48 | 6 | [DD News](https://ddnews.gov.in/); [Dainik Bhaskar](https://www.bhaskar.com/); [Press Trust of India](https://www.ptinews.com/) | — |
| 영국 (GB) | 164/164 | 5 | [The Times and The Sunday Times](https://www.thetimes.com/) | [Reuters](https://www.reuters.com/) (다른 국가 등록) |
| 프랑스 (FR) | 91/104 | 5 | [Agence France-Presse (AFP)](https://www.afp.com/) | [Les Echos](https://www.lesechos.fr/) (비활성) |
| 이탈리아 (IT) | 110/115 | 5 | — | — |
| 캐나다 (CA) | 220/223 | 6 | [The Canadian Press](https://www.thecanadianpress.com/) | — |
| 러시아 (RU) | 52/60 | 5 | — | — |
| 대한민국 (KR) | 51/55 | 6 | — | [MBC News](https://imnews.imbc.com/) (비활성) |
| 브라질 (BR) | 68/73 | 6 | [Agência Brasil](https://agenciabrasil.ebc.com.br/) | — |
| 오스트레일리아 (AU) | 168/175 | 5 | — | — |
| 스페인 (ES) | 59/66 | 5 | [Agencia EFE](https://efe.com/) | — |
| 멕시코 (MX) | 83/106 | 6 | — | [El Economista](https://www.eleconomista.com.mx/) (비활성) |
| 인도네시아 (ID) | 201/217 | 6 | [Harian Kompas / Kompas.id](https://www.kompas.id/); [TVRI](https://www.tvri.go.id/) | — |
| 모로코 (MA) | 49/50 | 6 | [Maghreb Arab Press / MAP](https://www.mapnews.ma/); [Le360](https://fr.le360.ma/); [2M](https://www.2m.ma/) | — |
| 네덜란드 (NL) | 179/187 | 5 | [Algemeen Nederlands Persbureau (ANP)](https://www.anp.nl/) | — |
| 스위스 (CH) | 87/106 | 5 | [Keystone-SDA](https://www.keystone-sda.ch/) | — |
| 튀르키예 (TR) | 58/72 | 6 | [Anadolu Agency](https://www.aa.com.tr/en) | — |
| 사우디아라비아 (SA) | 16/36 | 6 | — | [Al Riyadh](https://www.alriyadh.com/) (비활성) |
| 이스라엘 (IL) | 96/96 | 6 | [KAN](https://www.kan.org.il/) | — |
| 요르단 (JO) | 1/1 | 6 | [Jordan News Agency / Petra](https://www.petra.gov.jo/); [Al Rai Jordan](https://www.alrai.com/); [Ad-Dustour](https://www.addustour.com/); [The Jordan Times](https://www.jordantimes.com/); [Roya News](https://www.royanews.tv/) | — |
| 쿠웨이트 (KW) | 0/0 | 6 | [Kuwait News Agency / KUNA](https://www.kuna.net.kw/); [Al Qabas](https://www.alqabas.com/); [Al Rai Kuwait](https://www.alraimedia.com/); [Al Anba](https://www.alanba.com.kw/); [Al Jarida](https://www.aljarida.com/); [Kuwait Times](https://www.kuwaittimes.com/) | — |
| 대만 (TW) | 48/49 | 5 | [Commercial Times](https://www.ctee.com.tw/) | — |
| 폴란드 (PL) | 80/92 | 5 | — | — |
| 스웨덴 (SE) | 113/120 | 5 | [TT Nyhetsbyrån](https://tt.se/) | — |
| 벨기에 (BE) | 44/48 | 5 | [Belga](https://www.belga.be/) | — |
| 태국 (TH) | 79/90 | 5 | — | [Thai News Agency / MCOT](https://tna.mcot.net/) (비활성) |
| 이란 (IR) | 11/38 | 6 | [Donya-e-Eqtesad](https://donya-e-eqtesad.com/); [IRIB News](https://www.irib-news.ir/) | [IRNA](https://www.irna.ir/) (비활성); [ISNA](https://www.isna.ir/) (비활성); [Tehran Times](https://www.tehrantimes.com/) (비활성) |
| 아르헨티나 (AR) | 95/111 | 6 | [Noticias Argentinas](https://www.noticiasargentinas.com/) | — |
| 칠레 (CL) | 83/97 | 6 | — | — |
| 도미니카 공화국 (DO) | 81/84 | 6 | — | — |
| 우루과이 (UY) | 88/103 | 5 | — | — |
| 오스트리아 (AT) | 94/98 | 5 | [Austria Presse Agentur (APA)](https://apa.at/) | — |
| 뉴질랜드 (NZ) | 66/67 | 5 | — | — |
| 노르웨이 (NO) | 128/136 | 5 | [Norsk Telegrambyrå (NTB)](https://www.ntb.no/) | — |
| 아일랜드 (IE) | 114/118 | 5 | [Business Post](https://www.businesspost.ie/) | — |
| 포르투갈 (PT) | 53/54 | 5 | [Lusa](https://www.lusa.pt/) | — |
| 덴마크 (DK) | 130/131 | 5 | [Ritzau](https://www.ritzau.com/) | — |
| 핀란드 (FI) | 159/160 | 5 | [Suomen Tietotoimisto (STT)](https://stt.fi/) | — |
| 체코 (CZ) | 145/147 | 5 | — | — |
| 그리스 (GR) | 41/41 | 5 | [ERT News](https://www.ertnews.gr/); [Athens-Macedonian News Agency (ANA-MPA)](https://www.amna.gr/) | — |
| 루마니아 (RO) | 56/56 | 5 | [AGERPRES](https://agerpres.ro/); [TVR Info](https://tvrinfo.ro/) | — |
| 우크라이나 (UA) | 22/23 | 5 | [Suspilne News](https://suspilne.media/) | — |
| 룩셈부르크 (LU) | 16/16 | 5 | [Tageblatt](https://www.tageblatt.lu/) | — |
| 슬로바키아 (SK) | 96/96 | 5 | — | — |
| 헝가리 (HU) | 47/47 | 5 | [Magyar Távirati Iroda (MTI)](https://mti.hu/) | [Híradó.hu](https://hirado.hu/) (검토) |
| 불가리아 (BG) | 60/60 | 5 | — | — |
| 크로아티아 (HR) | 34/34 | 5 | [HINA](https://www.hina.hr/) | — |
| 슬로베니아 (SI) | 30/30 | 5 | — | — |
| 세르비아 (RS) | 37/37 | 5 | — | — |
| 리투아니아 (LT) | 29/29 | 5 | [Baltic News Service Lithuania (BNS)](https://www.bns.lt/) | — |
| 라트비아 (LV) | 49/49 | 5 | [LETA](https://www.leta.lv/); [Dienas Bizness](https://db.lv/) | — |
| 에스토니아 (EE) | 60/60 | 5 | [Baltic News Service Estonia (BNS)](https://www.bns.ee/) | [Eesti Päevaleht](https://epl.delfi.ee/) (검토) |
| 아이슬란드 (IS) | 22/22 | 5 | [Viðskiptablaðið](https://www.vb.is/) | — |
| 이집트 (EG) | 32/32 | 6 | [Al-Ahram / Ahram Online](https://english.ahram.org.eg/); [Middle East News Agency / MENA](https://www.mena.org.eg/); [Youm7](https://www.youm7.com/) | — |
| 나이지리아 (NG) | 31/31 | 6 | — | — |
| 싱가포르 (SG) | 60/60 | 4 | — | — |
| 남아프리카 (ZA) | 29/29 | 6 | — | [News24](https://www.news24.com/) (검토) |
| 바레인 (BH) | 1/1 | 5 | [Bahrain News Agency / BNA](https://www.bna.bh/); [Al Ayam](https://www.alayam.com/); [Akhbar Al Khaleej](https://www.akhbar-alkhaleej.com/); [Gulf Daily News / Gulf Digital News](https://www.gdnonline.com/); [The Daily Tribune / News of Bahrain](https://www.newsofbahrain.com/) | — |
| 카타르 (QA) | 21/21 | 5 | — | — |
| 아랍에미리트 (AE) | 23/23 | 5 | — | [Al Ittihad](https://www.aletihad.ae/) (검토) |
| 엘살바도르 (SV) | 16/16 | 5 | [La Prensa Gráfica](https://www.laprensagrafica.com/); [El Faro](https://elfaro.net/) | — |
| 에콰도르 (EC) | 34/34 | 5 | — | — |
| 오만 (OM) | 7/7 | 5 | [Oman News Agency / ONA](https://www.omannews.gov.om/); [Al Watan Oman](https://www.alwatan.om/) | — |
| 콜롬비아 (CO) | 18/18 | 6 | [Noticias Caracol](https://www.noticiascaracol.com/); [Noticias RCN](https://www.noticiasrcn.com/) | — |
| 말레이시아 (MY) | 45/46 | 5 | [RTM / Berita RTM](https://www.rtm.gov.my/); [The Edge Malaysia](https://theedgemalaysia.com/) | — |
| 필리핀 (PH) | 91/94 | 6 | [ABS-CBN News](https://www.abs-cbn.com/news); [Philippine News Agency](https://www.pna.gov.ph/) | — |
| 베트남 (VN) | 67/67 | 5 | — | — |
| 몽골 (MN) | 4/4 | 5 | [MONTSAME](https://montsame.mn/en/); [Mongolian National Broadcaster / MNB](https://www.mnb.mn/); [Unuudur](https://www.unuudur.mn/) | [GoGo](https://gogo.mn/) (검토) |
| 파키스탄 (PK) | 2/2 | 5 | [Associated Press of Pakistan](https://www.app.com.pk/); [Business Recorder](https://www.brecorder.com/); [PTV News](https://ptv.com.pk/) | — |
| 카자흐스탄 (KZ) | 21/21 | 5 | [Egemen Qazaqstan](https://egemen.kz/); [Qazaqstan TV](https://qazaqstan.tv/) | — |

## 등록과 실제 수집의 차이

체크섬을 검증한 **58,803개 저장 검사 기록**에서 주소별 가장 최근 결과를 연결했다. 자료 시점은 **2026-10-14T05:00:48.369Z**다. 이번 조사의 실시간 재검사 결과가 아니다. 활성 등록으로 분류한 289개 대표 매체 중 223개는 해당 국가의 등록 주소에서 성공한 RSS/Atom/RDF/URL-set XML 기록이 적어도 하나 있다. 빈 XML이나 신규 발견 0건도 유효할 수 있으며, 이 수치는 현재 발행 기사 수·최신성·전체 섹션 확보율을 뜻하지 않는다.

활성 등록이 있으나 최신 저장 결과에서 성공한 기사 XML을 확인하지 못한 매체 48개는 별도 주소 검토 대상이다. 저장 결과만으로 지속 장애를 확정하지 않는다. 인덱스만 확인되는 매체는 18개다.

소속이나 형식 검토가 남은 GoGo·News24·Al Ittihad의 활성 등록행은 위 세 집계에서 제외했다. Al Ittihad로 이름이 붙은 Azure 주소에는 XML 성공 기록이 있지만, 실제 매체 소속은 미확인이라 확보된 수집 범위로 세지 않았다. 합본 JSON은 주소별 기술적 결과와 검토 상태를 함께 남기고 별도 집계를 제공한다.

| 국가 | 매체 | 인덱스만 확인된 저장 근거 |
| --- | --- | --- |
| 일본 (JP) | [Asahi Shimbun](https://www.asahi.com/) | [등록 인덱스](https://www.asahi.com/sitemap.xml) (2026-10-14T03:19:42.964Z) |
| 오스트레일리아 (AU) | [Australian Associated Press](https://www.aap.com.au/) | [등록 인덱스](https://aap.com.au/sitemap.xml) (2026-10-14T03:19:11.051Z) |
| 오스트레일리아 (AU) | [The Australian](https://www.theaustralian.com.au/) | [등록 인덱스](https://www.theaustralian.com.au/sitemap.xml) (2026-10-14T03:19:45.460Z) |
| 인도네시아 (ID) | [Detikcom](https://www.detik.com/) | [등록 인덱스](https://www.detik.com/sitemap.xml) (2026-10-14T03:19:29.185Z) |
| 대만 (TW) | [United Daily News / UDN](https://udn.com/) | [등록 인덱스](https://udn.com/sitemapxml/news/mapindex.xml) (2026-10-14T03:18:43.024Z) |
| 싱가포르 (SG) | [Lianhe Zaobao](https://www.zaobao.com.sg/) | [등록 인덱스](https://www.zaobao.com.sg/sitemap.xml) (2026-10-14T03:18:42.727Z) |
| 말레이시아 (MY) | [New Straits Times](https://www.nst.com.my/) | [등록 인덱스](https://www.nst.com.my/sitemap.xml) (2026-10-14T03:18:58.394Z) |
| 이탈리아 (IT) | [RaiNews](https://www.rainews.it/) | [등록 인덱스](https://www.rainews.it/sitemap.xml) (2026-10-14T03:19:51.685Z) |
| 포르투갈 (PT) | [Jornal de Negócios](https://www.jornaldenegocios.pt/) | [등록 인덱스](https://www.jornaldenegocios.pt/sitemap) (2026-10-14T03:18:00.039Z) |
| 우크라이나 (UA) | [Interfax-Ukraine](https://interfax.com.ua/) | [등록 인덱스](https://interfax.com.ua/google-news-sitemap.xml) (2026-10-14T03:17:36.938Z) |
| 헝가리 (HU) | [Index.hu](https://index.hu/) | [등록 인덱스](http://index.hu/sitemap/sitemapindex.xml) (2026-10-14T03:17:32.359Z) |
| 불가리아 (BG) | [BNT News](https://bntnews.bg/) | [등록 인덱스](https://bntnews.bg/sitemap.xml) (2026-10-14T03:18:39.803Z) |
| 불가리아 (BG) | [BNR](https://bnr.bg/) | [등록 인덱스](https://bnr.bg/sitemap.xml) (2026-10-14T03:18:35.268Z) |
| 미국 (US) | [Reuters](https://www.reuters.com/) | [등록 인덱스](https://www.reuters.com/arc/outboundfeeds/news-sitemap-index/?outputType=xml) (2026-10-14T03:19:31.432Z) |
| 캐나다 (CA) | [The Globe and Mail](https://www.theglobeandmail.com/) | [등록 인덱스](https://www.theglobeandmail.com/sitemap.xml?outputType=xml) (2026-10-14T03:19:21.074Z) |
| 브라질 (BR) | [O Estado de S. Paulo / Estadão](https://www.estadao.com.br/) | [등록 인덱스](https://www.estadao.com.br/arc/outboundfeeds/sitemap-index-by-day/?outputType=xml) (2026-10-14T03:17:24.997Z) |
| 멕시코 (MX) | [Milenio](https://www.milenio.com/) | [등록 인덱스](https://www.milenio.com/sitemap/sitemap-google-news-index.xml) (2026-10-14T03:19:59.145Z); [등록 인덱스](https://www.milenio.com/sitemap/sitemap-articles-index.xml) (2026-10-14T03:18:07.552Z) |
| 이집트 (EG) | [Al Mal](https://www.almalnews.com/) | [등록 인덱스](https://almalnews.com/sitemaps.xml) (2026-10-14T03:18:07.276Z) |

Reuters는 미국 항목에 등록돼 있지만 기사 URL-set이 아닌 news-sitemap-index만 있다. 따라서 미등록 언론사로 추가하기보다, 공식 인덱스가 선언한 하위 기사 사이트맵을 검토해야 한다. 몽골 GoGo는 홈페이지가 sitemapUrl로 등록돼 있어 별도 검토로 분리했다. 일본 Kyodo의 Yahoo 언론사 전용 RSS는 이미 등록된 것으로 처리했다.

## 다음 적용 단계

1. 미등록 후보의 공식 공개 RSS·사이트맵 선언을 찾고 현재 robots 정책, XML 형식, 기사 URL 포함 여부, 중복·국가·언어를 확인한다.
2. 서버에서 제한된 검증을 실시해 로컬 접근 성공과 실제 운영 수집 성공을 구분한다. 통신사 사이트에 공개 피드가 없으면 기사 공급 계약이나 대체 공식 배포 가능성을 별도로 확인한다.
3. 신규 후보 추가안을 검토 가능하게 만들고, 기존 주소 교체·비활성 해제는 개별 관리자 승인 절차를 거친다.
4. 적용된 새 주소의 첫 관측은 baseline으로 처리하고, 다음 정기 회차에서 실제 수집과 대시보드 반영을 확인한다.

이번에는 **레지스트리 변경 0, 수집 작업 시작 0, 후보 XML 요청 0, 유료 모델 호출 0**이다. 공식 선언을 찾은 주소도 검증 완료나 추가 승인 상태로 표시하지 않았다.

## 근거 파일

- [합본 및 주소별 저장 검사 근거](audit.json)
- [아시아·태평양 18개국](asia-pacific.json)
- [유럽 32개국](europe.json)
- [미주·아프리카·중동 23개국](americas-africa-middle-east.json)
- [실제 타이머 조회](schedule-verification.json)

레지스트리 SHA-256: **2eb21a9856ec8e5cbc6a38417aeac1b93addcf0684f7bf3ef6e57af45ef2bdc3**. 원본 레지스트리와 검사 이력은 기존 비공개 운영 스냅샷에서 읽었고 변경하지 않았다. [summarize.mjs](summarize.mjs)는 해당 로컬 스냅샷과 빌드된 dist가 있을 때 읽기 전용 대조 결과를 다시 만들며, [render-report.mjs](render-report.mjs)는 이 문서를 생성한다.
