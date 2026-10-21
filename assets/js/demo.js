/* naubert-bot · demo.js
 * Simulação da tela inteira, sem microfone e sem chamar a API.
 *
 * Serve para mostrar o comportamento do painel — inclusive o duotone e o
 * veredito sobre o vídeo. Tudo o que aparece aqui é ILUSTRATIVO: os cartões
 * levam a etiqueta "simulação" e as fontes apontam para as homepages dos
 * veículos, não para matérias reais. Não use este modo para checar de verdade.
 */
(function (global) {
  'use strict';
  var NB = (global.NB = global.NB || {});

  function src(veiculo, url, titulo) {
    var host = NB.outlets.hostOf(url);
    return {
      veiculo: veiculo,
      url: url,
      titulo: titulo || 'página inicial do veículo (fonte simulada)',
      host: host,
      data: '',
      trecho: '',
      domainOk: true,
      seenInSearch: true,
      citedByModel: true,
      status: 'confirmada',
      motivo: 'simulação'
    };
  }

  var SCRIPT = [
    {
      type: 'opinion',
      line: 'Olha, na minha opinião, este é o pior governo que o país já teve. E eu digo isso com convicção.',
      claim: {
        texto: 'Este é o pior governo que o país já teve.',
        falante: 'candidato A',
        tipo: 'opiniao',
        tema: 'avaliação',
        prioridade: 3
      },
      reason: 'opinião — não é afirmação verificável'
    },
    {
      type: 'claim',
      line: 'A Constituição de 1988 diz, no artigo 196, que a saúde é direito de todos e dever do Estado.',
      claim: {
        texto: 'A Constituição de 1988 prevê, no artigo 196, que a saúde é direito de todos e dever do Estado.',
        falante: 'candidato B',
        tipo: 'checavel',
        tema: 'saúde',
        prioridade: 1
      },
      result: {
        veredito: 'VERDADEIRO',
        explicacao: 'O artigo 196 da Constituição Federal de 1988 afirma exatamente isso: a saúde é direito de todos e dever do Estado, garantido por políticas sociais e econômicas.',
        correcao: 'Texto constitucional confirmado, sem ressalva.',
        confianca: 0.97,
        fontes: [src('Planalto', 'https://www.gov.br/planalto/pt-br', 'Constituição da República Federativa do Brasil — texto consolidado')],
        termos: 'artigo 196 Constituição saúde direito de todos dever do Estado',
        consultas: ['artigo 196 Constituição Federal saúde direito de todos dever do Estado'],
        buscas: 1,
        latencia: 6400
      }
    },
    {
      type: 'claim',
      line: 'O Brasil tem hoje duzentos e treze milhões de habitantes, isso está no Censo 2022 do IBGE.',
      claim: {
        texto: 'O Brasil tem 213 milhões de habitantes, segundo o Censo 2022 do IBGE.',
        falante: 'candidato A',
        tipo: 'checavel',
        tema: 'população',
        prioridade: 1
      },
      result: {
        veredito: 'ENGANOSO',
        explicacao: 'O Censo 2022 contou 203 milhões de habitantes. Os 213 milhões correspondem a uma estimativa populacional de outro momento, divulgada antes do censo — o número não é o resultado do Censo 2022.',
        correcao: 'Censo 2022: 203.062.512 habitantes. A estimativa de 213 milhões é de 2021 e foi substituída pela contagem censitária.',
        confianca: 0.91,
        fontes: [
          src('IBGE', 'https://www.ibge.gov.br/', 'Censo Demográfico 2022 — população recenseada'),
          src('g1', 'https://g1.globo.com/', 'IBGE divulga resultados do Censo 2022 (fonte simulada)')
        ],
        termos: 'Censo 2022 população Brasil 203 milhões IBGE',
        consultas: ['Censo 2022 população Brasil IBGE', 'estimativa população 213 milhões 2021'],
        buscas: 2,
        latencia: 9200
      }
    },
    {
      type: 'claim',
      line: 'O salário mínimo brasileiro está congelado há oito anos, sem nenhum reajuste real.',
      claim: {
        texto: 'O salário mínimo está congelado há oito anos, sem nenhum reajuste.',
        falante: 'candidato B',
        tipo: 'checavel',
        tema: 'trabalho',
        prioridade: 2
      },
      result: {
        veredito: 'FALSO',
        explicacao: 'O salário mínimo é reajustado todos os anos por lei. Houve reajustes anuais no período, inclusive acima da inflação em vários anos. Não existe congelamento de oito anos.',
        correcao: 'O mínimo tem reajuste anual previsto em lei; em nenhum dos últimos oito anos deixou de ser reajustado.',
        confianca: 0.93,
        fontes: [src('gov.br', 'https://www.gov.br/trabalho-e-emprego/pt-br', 'Reajuste do salário mínimo — série histórica (fonte simulada)')],
        termos: 'salário mínimo reajuste anual série histórica',
        consultas: ['salário mínimo reajuste anual histórico Brasil'],
        buscas: 1,
        latencia: 7300
      }
    },
    {
      type: 'claim',
      line: 'A carga tributária brasileira é a maior do mundo, não tem nenhum país que cobre mais imposto que a gente.',
      claim: {
        texto: 'A carga tributária brasileira é a maior do mundo.',
        falante: 'candidato A',
        tipo: 'checavel',
        tema: 'tributos',
        prioridade: 2
      },
      result: {
        veredito: 'FALSO',
        explicacao: 'O Brasil tem carga tributária alta para padrões emergentes, mas está longe de ser a maior do mundo: países como Dinamarca, França e Noruega cobram proporção maior do PIB.',
        correcao: 'A carga brasileira fica na casa de um terço do PIB; Dinamarca e França superam 40%.',
        confianca: 0.89,
        fontes: [
          src('Valor', 'https://valor.globo.com/', 'Carga tributária por país — comparação internacional (fonte simulada)'),
          src('Exame', 'https://exame.com/', 'Quanto o brasileiro paga de imposto (fonte simulada)')
        ],
        termos: 'carga tributária Brasil comparação internacional OCDE',
        consultas: ['carga tributária Brasil comparada OCDE', 'maior carga tributária do mundo país'],
        buscas: 2,
        latencia: 11100
      }
    },
    {
      type: 'claim',
      line: 'O Supremo Tribunal Federal é composto por onze ministros, e isso está na Constituição.',
      claim: {
        texto: 'O STF é composto por onze ministros, conforme a Constituição.',
        falante: 'mediador',
        tipo: 'checavel',
        tema: 'judiciário',
        prioridade: 3
      },
      result: {
        veredito: 'VERDADEIRO',
        explicacao: 'O artigo 101 da Constituição fixa em onze o número de ministros do Supremo Tribunal Federal.',
        correcao: 'Confirmado: onze ministros.',
        confianca: 0.96,
        fontes: [src('STF', 'https://portal.stf.jus.br/', 'Composição do Supremo Tribunal Federal')],
        termos: 'STF onze ministros artigo 101',
        consultas: ['STF composição onze ministros Constituição'],
        buscas: 1,
        latencia: 5800
      }
    },
    {
      type: 'opinion',
      line: 'Eu tenho certeza de que, se eu for eleito, o país vai crescer quatro por cento no primeiro ano.',
      claim: {
        texto: 'Se eu for eleito, o país vai crescer 4% no primeiro ano.',
        falante: 'candidato B',
        tipo: 'previsao',
        tema: 'economia',
        prioridade: 2
      },
      reason: 'previsão — não é fato verificável agora'
    },
    {
      type: 'claim',
      line: 'Nenhum país do mundo conseguiu reduzir a desigualdade sem crescimento econômico.',
      claim: {
        texto: 'Nenhum país do mundo conseguiu reduzir a desigualdade sem crescimento econômico.',
        falante: 'candidato A',
        tipo: 'checavel',
        tema: 'desigualdade',
        prioridade: 2
      },
      result: {
        veredito: 'NAO_VERIFICADO',
        explicacao: 'A busca restrita não trouxe estudo comparativo que sustente a afirmação absoluta. Há casos de redução de desigualdade com crescimento baixo, mas a literatura não fecha uma regra geral.',
        correcao: 'A afirmação é ampla demais para confirmar ou refutar com as fontes consultadas.',
        confianca: 0.42,
        fontes: [],
        termos: 'desigualdade crescimento econômico evidência comparada',
        consultas: ['redução desigualdade sem crescimento econômico países'],
        buscas: 2,
        latencia: 10400,
        rebaixado: false
      }
    }
  ];

  function Demo(hooks) {
    this.hooks = hooks || {};
    this.timers = [];
    this.running = false;
    this.i = 0;
  }

  Demo.prototype._later = function (ms, fn) {
    var self = this;
    this.timers.push(
      setTimeout(function () {
        if (self.running) fn();
      }, ms)
    );
  };

  Demo.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this.i = 0;
    this.session = Date.now().toString(36);

    var self = this;
    var t = 700;

    SCRIPT.forEach(function (step) {
      self._later(t, function () {
        self.hooks.transcript && self.hooks.transcript(step.line);
      });
      t += 900;

      if (step.type === 'opinion') {
        self._later(t, function () {
          self.hooks.skipped && self.hooks.skipped(step.claim, step.reason);
        });
        t += 1200;
        return;
      }

      var claim = Object.assign(
        {
          id: 'demo' + self.session + '-' + self.i++,
          status: 'triada',
          contexto: '',
          iniciadaEm: Date.now(),
          porque: 'afirmação com dado verificável'
        },
        step.claim,
        { demo: true }
      );

      self._later(t, function () {
        self.hooks.pending && self.hooks.pending(claim);
      });
      t += 900;

      self._later(t, function () {
        var result = Object.assign({}, claim, step.result, {
          status: 'concluida',
          demo: true,
          simulacao: true,
          concluidaEm: Date.now(),
          latencia: step.result.latencia || 7000,
          confianca: step.result.confianca || 0.8
        });
        self.hooks.result && self.hooks.result(result);
      });
      t += 2400;
    });

    this._later(t + 600, function () {
      self.hooks.done && self.hooks.done();
      self.running = false;
    });
  };

  Demo.prototype.stop = function () {
    this.running = false;
    this.timers.forEach(clearTimeout);
    this.timers = [];
  };

  NB.demo = { Demo: Demo, SCRIPT: SCRIPT };
})(window);
