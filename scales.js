const tonal = require('tonal');
const neo4j = require('neo4j-driver').v1;
const Promise = require('bluebird');

const driver = neo4j.driver(process.env.NEO4J_URL || 'bolt://localhost',
  neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD));
const session = driver.session();

const aliases = {
  'B##': 'C#',
  'C##': 'D',
  'D##': 'E',
  'F##': 'G',
  'G##': 'A',
  'A##': 'A',
  'E##': 'F#',
  'Dbb': 'C',
  'Ebb': 'D',
  'Abb': 'G',
  'Bbb': 'A',
  'Cbb': 'B',
};

const alias = note => {
  if (aliases[note]) {
    return aliases[note];
  }

  return note;
};

const tonics = [
  'A', 'A#', 'Bb', 'B', 'C',
  'D', 'D#', 'Eb', 'F', 'F#',
  'Gb', 'G', 'G#', 'Ab',
];

let queriesRun = 0;
const queriesAndParams = [];

const runQueryWithParams = qAndP => {
  queriesRun++;
  if (queriesRun % 50 === 0) {
    console.log('Run ', queriesRun, 'of ', queriesAndParams.length);
  }
  return session.run(qAndP[0], qAndP[1]);
}

const concurrency = { concurrency: 1 };

console.log('Creating scales and intervals...');

const indexes = [':Interval(name)', ':Tone(name)', ':Scale(name)', ':Chord(name)', ':ScaleInstance(name)'];

const initIndexes = () =>
  Promise.map(indexes,
    idx => session.run(`CREATE INDEX on ${idx}`),
    concurrency);

const initChords = () =>
  Promise.map(tonal.Chord.names(),
    chordName => session.run('MERGE (c:Chord { name: $chordName })',
      { chordName }), concurrency);

const initNotes = () =>
  Promise.map(tonics,
    tonic => session.run('MERGE (t:Tone { name: $tonic })', { tonic }), concurrency)

const initIntervals = () =>
  Promise.map(tonal.Interval.names(), intervalName => {
    return session.run('MERGE (i:Interval { name: $intervalName })', { intervalName });
  }, concurrency);

const initScales = () =>
  Promise.map(tonal.Scale.names(), scaleName => {
    return session.run('MERGE (s:Scale { name: $scaleName })', { scaleName });
  }, concurrency);

return initIndexes()
  .then(initScales)
  .then(initNotes)
  .then(initChords)
  .then(initIntervals)
  .then(() => {
    tonal.scale.names().map(scaleName => {
      tonics.map(tonic => {
        const intervals = tonal.scale(scaleName);
        const scale = intervals.map(tonal.transpose(`${tonic}`));

        const scaleInstanceName = `${tonic} ${scaleName}`;

        const query = `
          MATCH (scale:Scale { name: $scaleName })
          MERGE (scaleInstance:ScaleInstance { name: $scaleInstanceName })
          MERGE (scaleInstance)-[:instance_of]->(scale)`;
        queriesAndParams.push([query, { scaleName, scaleInstanceName }]);

        intervals.map(name => {
          queriesAndParams.push([
            `MATCH (i:Interval { name: $name }) 
             MATCH (s:Scale { name: $scaleName })
             MERGE (s)-[:contains]->(i)`, { scaleName, name }
          ])
        });

        scale.map(note => {
          queriesAndParams.push([
            `MATCH (n:Tone { name: $note })
             MATCH (si:ScaleInstance { name: $scaleInstanceName })
             MERGE (n)-[:in]->(si)
            `,
            { note: `${note}`, scaleInstanceName: `${scaleInstanceName}` }]);
        });
      });
    });

    // Run the bulk queries, concurrency here is critical.
    return Promise.map(queriesAndParams, qAndP => runQueryWithParams(qAndP), concurrency);
  })
  .then(() => console.log('All done'))
  .catch(err => console.error(err))
  .then(() => driver.close());

