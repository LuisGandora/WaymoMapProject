// Intro narration played when a tour is generated: one ~20 s script per theme, in every narration language.
// Shared by the /api/narrate route (text sent to ElevenLabs) and the player (transcript + place chips).
// Nothing secret lives here; the ElevenLabs key only exists server-side in app/api/narrate/route.ts.

export type Lang = "en" | "es" | "pt";
export const LANGS: readonly Lang[] = ["en", "es", "pt"];
export const isLang = (v: unknown): v is Lang => typeof v === "string" && (LANGS as readonly string[]).includes(v);

// at: [lng, lat] the camera flies to. cue: words that name the place in the scripts; the first one found in the
// script marks when (as a fraction of the clip) the story camera moves there.
export type Place = { name: string; blurb: string; kicker: Record<Lang, string>; at?: [number, number]; cue?: string[] };
export type Narration = { id: NarrationId; title: Record<Lang, string>; places: Place[]; script: Record<Lang, string> };
export type NarrationId = "wynwood" | "museums" | "landmarks" | "food";

export const NARRATIONS: Record<NarrationId, Narration> = {
  wynwood: {
    id: "wynwood",
    title: { en: "Wynwood Street Art", es: "Arte urbano de Wynwood", pt: "Arte de rua de Wynwood" },
    places: [
      {
        name: "Wynwood Walls",
        blurb: "The global epicenter of street art: a rotating collection of massive murals by international artists.",
        kicker: { en: "Open-air street art museum", es: "Museo de arte urbano al aire libre", pt: "Museu de arte de rua a céu aberto" },
        at: [-80.1994, 25.8011],
        cue: ["Wynwood Walls"],
      },
      {
        name: "Margulies Collection",
        blurb: "A 50,000 sq ft retrofitted warehouse of world-class contemporary sculpture, photography and video art.",
        kicker: { en: "Contemporary art warehouse", es: "Almacén de arte contemporáneo", pt: "Armazém de arte contemporânea" },
        at: [-80.204, 25.8023],
        cue: ["Margulies"],
      },
      {
        name: "Panther Coffee",
        blurb: "Iconic local roaster with a huge patio wrapped around a historic tree: the neighborhood's gathering spot.",
        kicker: { en: "Local roaster & gathering spot", es: "Tostador local y punto de encuentro", pt: "Torrefação local e ponto de encontro" },
        at: [-80.199, 25.7997],
        cue: ["Panther"],
      },
    ],
    script: {
      en: "Welcome to Wynwood, Miami's beating creative heart. Look out your window: the Wynwood Walls, an open-air museum where the world's greatest street artists turned old warehouses into massive, vibrant canvases. Nearby, the Margulies Collection hides world-class contemporary art inside a converted warehouse, and Panther Coffee fuels the artists. Keep your eyes peeled. Around here, even the sidewalks are art.",
      es: "Bienvenidos a Wynwood, el corazón creativo de Miami. Miren por la ventana: los Wynwood Walls, un museo al aire libre donde los mejores artistas urbanos del mundo convirtieron viejos almacenes en lienzos enormes y vibrantes. Muy cerca, la Colección Margulies guarda arte contemporáneo de primer nivel en un antiguo almacén, y Panther Coffee le da energía a los artistas. Mantengan los ojos abiertos. Aquí, hasta las aceras son arte.",
      pt: "Bem-vindos a Wynwood, o coração criativo de Miami. Olhem pela janela: os Wynwood Walls, um museu a céu aberto onde os maiores artistas de rua do mundo transformaram antigos armazéns em telas enormes e vibrantes. Bem perto, a Coleção Margulies guarda arte contemporânea de primeira linha num antigo armazém, e o Panther Coffee abastece os artistas. Fiquem de olho. Aqui, até as calçadas são arte.",
    },
  },
  museums: {
    id: "museums",
    title: { en: "Waterfront Museums", es: "Museos frente al mar", pt: "Museus à beira-mar" },
    places: [
      {
        name: "Maurice A. Ferré Park",
        blurb: "Bayfront park downtown that is home to both museums.",
        kicker: { en: "Bayfront museum park", es: "Parque de museos frente a la bahía", pt: "Parque dos museus à beira da baía" },
        at: [-80.1862, 25.7843],
        cue: ["Ferré"],
      },
      {
        name: "Pérez Art Museum (PAMM)",
        blurb: "Herzog & de Meuron's contemporary art museum, famous for its shaded bayfront terrace and hanging gardens.",
        kicker: { en: "Contemporary art · hanging gardens", es: "Arte contemporáneo · jardines colgantes", pt: "Arte contemporânea · jardins suspensos" },
        at: [-80.1864, 25.7859],
        cue: ["Pérez"],
      },
      {
        name: "Frost Science Museum",
        blurb: "A 250-seat planetarium and a three-level aquarium with a 31 ft oculus looking up into a shark habitat.",
        kicker: { en: "Planetarium & shark aquarium", es: "Planetario y acuario de tiburones", pt: "Planetário e aquário de tubarões" },
        at: [-80.1878, 25.7852],
        cue: ["Frost"],
      },
    ],
    script: {
      en: "As we glide along the waterfront, we're entering Maurice A. Ferré Park, home to two architectural masterpieces. The Pérez Art Museum is famous for its hanging gardens suspended over Biscayne Bay. Right beside it, the Frost Science Museum hides a three-level aquarium where you can look straight up into a shark tank. This is where human creativity meets the wonders of the natural world.",
      es: "Mientras recorremos el malecón, entramos al Parque Maurice A. Ferré, hogar de dos obras maestras de la arquitectura. El Museo de Arte Pérez es famoso por sus jardines colgantes sobre la Bahía de Biscayne. Justo al lado, el Museo de Ciencias Frost esconde un acuario de tres niveles donde puedes mirar hacia arriba, directo a un tanque de tiburones. Aquí la creatividad humana se encuentra con las maravillas de la naturaleza.",
      pt: "Enquanto deslizamos pela orla, entramos no Parque Maurice A. Ferré, lar de duas obras-primas da arquitetura. O Museu de Arte Pérez é famoso pelos jardins suspensos sobre a Baía de Biscayne. Logo ao lado, o Museu de Ciência Frost esconde um aquário de três andares onde você olha para cima, direto para um tanque de tubarões. Aqui a criatividade humana encontra as maravilhas da natureza.",
    },
  },
  landmarks: {
    id: "landmarks",
    title: { en: "Legendary Landmarks", es: "Lugares legendarios", pt: "Marcos lendários" },
    places: [
      {
        name: "Art Deco District",
        blurb: "The world's largest concentration of 1920s–30s resort architecture: pastel facades, porthole windows, neon.",
        kicker: { en: "Pastel & neon, 1930s South Beach", es: "Pastel y neón, South Beach de los años 30", pt: "Pastel e neon, South Beach dos anos 30" },
        at: [-80.1303, 25.7803],
        cue: ["Art Deco", "Art Déco"],
      },
      {
        name: "Freedom Tower",
        blurb: "The 1925 \"Ellis Island of the South\", a symbol of Miami's Cuban heritage.",
        kicker: { en: "The Ellis Island of the South", es: "La Isla Ellis del Sur", pt: "A Ellis Island do Sul" },
        at: [-80.1897, 25.7792],
        cue: ["Freedom Tower", "Torre de la Libertad"],
      },
      {
        name: "Vizcaya Museum & Gardens",
        blurb: "A 1916 Gilded Age estate in Coconut Grove built like an 18th-century Italian villa on Biscayne Bay.",
        kicker: { en: "1916 Italian-style villa on the bay", es: "Villa italiana de 1916 frente a la bahía", pt: "Vila italiana de 1916 na baía" },
        at: [-80.2105, 25.7444],
        cue: ["Vizcaya"],
      },
      {
        name: "Venetian Causeway",
        blurb: "A historic causeway that skips across the bay over man-made islands and drawbridges.",
        kicker: { en: "Island-hopping drawbridges", es: "Puentes levadizos entre islas", pt: "Pontes levadiças entre ilhas" },
        at: [-80.164, 25.7905],
        cue: ["Venetian", "Veneciana"],
      },
      {
        name: "The Biltmore Hotel",
        blurb: "Coral Gables' 1926 landmark, with a tower modeled on Seville's Giralda and a giant pool.",
        kicker: { en: "1926 Coral Gables landmark", es: "Ícono de Coral Gables de 1926", pt: "Ícone de Coral Gables de 1926" },
        at: [-80.2787, 25.7212],
      },
    ],
    script: {
      en: "We're now passing some of Miami's most legendary landmarks. Across the bay, the Art Deco district glows in pastel and neon, the style that defined the 1930s. Downtown stands the Freedom Tower, the Ellis Island of the South, which welcomed thousands of Cuban exiles. From Vizcaya's Italian villa to the drawbridges of the Venetian Causeway, Miami is a living canvas of history.",
      es: "Ahora pasamos por algunos de los lugares más legendarios de Miami. Al otro lado de la bahía, el distrito Art Deco brilla en tonos pastel y neón, el estilo que definió los años treinta. En el centro se alza la Torre de la Libertad, la Isla Ellis del Sur, que recibió a miles de exiliados cubanos. Desde la villa italiana de Vizcaya hasta los puentes levadizos de la Calzada Veneciana, Miami es un lienzo vivo de historia.",
      pt: "Agora passamos por alguns dos marcos mais lendários de Miami. Do outro lado da baía, o distrito Art Déco brilha em tons pastel e neon, o estilo que definiu os anos trinta. No centro ergue-se a Freedom Tower, a Ellis Island do Sul, que acolheu milhares de exilados cubanos. Da vila italiana de Vizcaya às pontes levadiças da Venetian Causeway, Miami é uma tela viva de história.",
    },
  },
  food: {
    id: "food",
    title: { en: "Cuban Cafés & Flavors", es: "Cafés y sabores cubanos", pt: "Cafés e sabores cubanos" },
    places: [
      {
        name: "Ventanita cafecito",
        blurb: "Walk-up coffee windows pouring tiny, sugary shots of Cuban espresso all day.",
        kicker: { en: "Cuban coffee, through the window", es: "Café cubano por la ventanita", pt: "Café cubano pela janelinha" },
        cue: ["ventanita"],
      },
      {
        name: "Calle Ocho",
        blurb: "Little Havana's main street: cigar shops, Domino Park and live music.",
        kicker: { en: "Little Havana's main street", es: "La calle principal de la Pequeña Habana", pt: "A rua principal de Little Havana" },
        at: [-80.2197, 25.7655],
        cue: ["Calle Ocho"],
      },
      {
        name: "Versailles",
        blurb: "The legendary Cuban restaurant on Calle Ocho, serving Miami since 1971.",
        kicker: { en: "Legendary Cuban restaurant · since 1971", es: "Restaurante cubano legendario · desde 1971", pt: "Restaurante cubano lendário · desde 1971" },
        at: [-80.253, 25.7652],
        cue: ["Versailles"],
      },
    ],
    script: {
      en: "Hungry? You're in the right city. Miami runs on cafecito, a tiny, sugary shot of Cuban espresso served through a ventanita, a walk-up coffee window, at every hour of the day. Grab a guava pastelito and a warm croqueta, then follow the smell of roast pork to Calle Ocho in Little Havana, where Versailles has been feeding the city since 1971.",
      es: "¿Tienen hambre? Están en la ciudad correcta. Miami funciona con cafecito, un trago pequeño y dulce de café cubano que se sirve por la ventanita a cualquier hora del día. Pidan un pastelito de guayaba y una croqueta calientita, y luego sigan el olor a lechón asado hasta la Calle Ocho en la Pequeña Habana, donde el Versailles alimenta a la ciudad desde 1971.",
      pt: "Com fome? Vocês estão na cidade certa. Miami funciona à base de cafecito, uma dose pequena e doce de café cubano servida pela ventanita, a janelinha de café, a qualquer hora do dia. Peguem um pastelito de goiaba e uma croqueta quentinha, depois sigam o cheiro de porco assado até a Calle Ocho, em Little Havana, onde o Versailles alimenta a cidade desde 1971.",
    },
  },
};

// Tour mood (Dashboard MOODS ids) -> script. "surprise" is resolved to a random script on the client.
const MOOD_TO_NARRATION: Record<string, NarrationId> = {
  "murals+sunset": "wynwood",
  murals: "wynwood",
  food: "food",
  historic: "landmarks",
  art_deco: "landmarks",
  water: "museums",
  sunset: "museums",
};

// Accepts a tour mood or a script id; unknown values fall back to Wynwood.
export function resolveNarration(moodOrId: string): Narration {
  if (moodOrId in NARRATIONS) return NARRATIONS[moodOrId as NarrationId];
  return NARRATIONS[MOOD_TO_NARRATION[moodOrId] ?? "wynwood"];
}

// When each place is spoken, as a fraction of the script (the same estimate the live captions use), in spoken order.
export function placeCues(n: Narration, lang: Lang): { i: number; frac: number }[] {
  const text = n.script[lang].toLowerCase();
  return n.places
    .map((p, i) => {
      const hits = (p.cue ?? []).map((c) => text.indexOf(c.toLowerCase())).filter((x) => x >= 0);
      return hits.length ? { i, frac: Math.min(...hits) / text.length } : null;
    })
    .filter((c): c is { i: number; frac: number } => c !== null)
    .sort((a, b) => a.frac - b.frac);
}

export function pickNarrationId(mood: string): NarrationId {
  if (mood !== "surprise") return resolveNarration(mood).id;
  const ids = Object.keys(NARRATIONS) as NarrationId[];
  return ids[Math.floor(Math.random() * ids.length)];
}

// Player chrome, in the narration language.
export const UI: Record<Lang, { now: string; generating: string; tap: string; transcript: string; retry: string; replay: string; passing: string; jump: string }> = {
  en: { now: "Now narrating", generating: "Generating voice…", tap: "Tap to listen", transcript: "Transcript", retry: "Retry", replay: "Replay", passing: "Now passing", jump: "Jump to this moment" },
  es: { now: "Narrando ahora", generating: "Generando voz…", tap: "Toca para escuchar", transcript: "Transcripción", retry: "Reintentar", replay: "Repetir", passing: "Pasando por", jump: "Ir a este momento" },
  pt: { now: "Narrando agora", generating: "Gerando voz…", tap: "Toque para ouvir", transcript: "Transcrição", retry: "Tentar de novo", replay: "Repetir", passing: "Passando por", jump: "Ir para este momento" },
};
