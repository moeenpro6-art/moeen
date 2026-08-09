import 'dotenv/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { resolveDatabaseConnectionString } from './database.config';
import {
  hashProviderAccessCode,
  providerAccessCodeLookupId,
} from './provider-access-code';
import { ServiceRequestRepository } from './service-request.repository';
import { StaffAuthRepository } from './staff-auth.repository';
import { generateOwnerToken, ownerTokenHash } from './test-db.guard';
const indexedProviderAccessCodeFixtures = [
  {
    providerId: 'PILOT-perf-0',
    accessCode: 'indexed-fixture-access-code-000',
    accessCodeHash:
      'scrypt$3074d0becfb0454a0c10ea7980f29504$e1b0c2b8884fd33bce6e2e8d2d8fddba855530655e2df65e236482bdef63194550d5ce976402f39c2c4082ca0a609ea920b3889c980b42ca203f55982ff087f2',
    lookupId:
      'edfa07d052c2917332fe35e90100c9ef2239c9a825e88edcd330c016cd85f52f',
  },
  {
    providerId: 'PILOT-perf-1',
    accessCode: 'indexed-fixture-access-code-001',
    accessCodeHash:
      'scrypt$797e62951406cfa00588ff22cf2e9e4b$db0455cbafbab407c7a308d357712d4b53abf2e88e2b14fcd9c9ecc8d698ed0743db8048888dbe024e948246d9dcb8f979fca31a4e96a8fa535dfec82af7c807',
    lookupId:
      'b20be95e82775acb1f61f85514deefb24fac6861a35ecdefdd161b1d737d6709',
  },
  {
    providerId: 'PILOT-perf-2',
    accessCode: 'indexed-fixture-access-code-002',
    accessCodeHash:
      'scrypt$7f08bb5662403ba3e7a8b2f11864aba8$109884b7692f4ae0eca17ef20cd432bd7ebd4a21757a50cdd280f0ab1625b7b0fab016a01439bf1092f88196185c46e470022956ab5a2649888975a1ee73e61e',
    lookupId:
      '9bbc77b162f6c6db4a18b12101ce1936da73d5d19fd32fa4b01d9ec97a2c08f4',
  },
  {
    providerId: 'PILOT-perf-3',
    accessCode: 'indexed-fixture-access-code-003',
    accessCodeHash:
      'scrypt$7bce0a7c2bd8b257605c296ba759ce20$3bd15c19fc86c79ef705e9baa16489b75bf13a2bdf91b4e55ea0c6647cd46835fb84cc480fca654697cf5d9e9df43f205c0bf2e67ca1c970f7510f732c640846',
    lookupId:
      'b48e3bac0377b69d54f9f11e66e02ab020cec1c2b0c13d6e64ea932be2944b90',
  },
  {
    providerId: 'PILOT-perf-4',
    accessCode: 'indexed-fixture-access-code-004',
    accessCodeHash:
      'scrypt$9982666fac6b0809036ea3cc3b2ce2a2$2a2c796d4a3a290f5d2507c87b8dfbf2537fa802320ec153912e4830b2439b5db28ec02aea6b270a436849f096472bab5e901d739c329961bfbe87d953bd0148',
    lookupId:
      '55ee8fc9c65546df8e4838f47e0368da12ffd6299718c349014e070dde850391',
  },
  {
    providerId: 'PILOT-perf-5',
    accessCode: 'indexed-fixture-access-code-005',
    accessCodeHash:
      'scrypt$7322956d0ecac8a7ae119d5b8bb1fb19$455034716151bacba3943f19e60d2bf7a0989bee3e4203e015367baefee0fd780d890381d84b3e3731438778c1d024d744d5d2cea1808e0974175487c6ff8160',
    lookupId:
      'a6031d21a1ad4895d58a6f522630450d347f596d015c67b662600289df86969a',
  },
  {
    providerId: 'PILOT-perf-6',
    accessCode: 'indexed-fixture-access-code-006',
    accessCodeHash:
      'scrypt$afa7529ddc252618ed27ed611cc9185c$2aff93246c0f5daedfb6a83a9a099f41d9ffd7f64d5f546a8117d8a8424c689b35fec218b75600d9bf2f5e07629ca7828fbbfaadbaece47f36a3bcb6b165a8f2',
    lookupId:
      '942f773951b8fd0545efc9dd31cb2c8891bcfa5266efb1d4f85ba913ee82cf54',
  },
  {
    providerId: 'PILOT-perf-7',
    accessCode: 'indexed-fixture-access-code-007',
    accessCodeHash:
      'scrypt$35e8bbd0848e44dd80803ac385dd0398$00d25601e372e13e987037a8e3d823fda2277a6432ee79ef27dddb0a1591d5f12440e2607a2471912f4ac1fedacd8ada3e105f616eeb5a80b9072a463053f26c',
    lookupId:
      '6d01076e1a661b092b66b073061755aa27aa8ab4b789408a7579d5c628d54b30',
  },
  {
    providerId: 'PILOT-perf-8',
    accessCode: 'indexed-fixture-access-code-008',
    accessCodeHash:
      'scrypt$2eea45a85164121190341e75f0221761$cae4456aa46b7d2dc9d1bf8a620a8d58d550813496e18bb7f742a1963f21735f9227e02e8cca93c28f33d012bb7fd56888b7a8b351fade6a7f76248b055fe6c5',
    lookupId:
      'acdc44af24529cbd10339048988326a213309282e6604df9b27fb316660844fc',
  },
  {
    providerId: 'PILOT-perf-9',
    accessCode: 'indexed-fixture-access-code-009',
    accessCodeHash:
      'scrypt$83a63c5982614499f0a86730e89fb922$5f42a4f02dd92e411c300b06311d5383d407604314009aab84646e06bd5f0b7a8ceb6a9408e4ec9fba29ba47c4523550069d03699bb72c435c06b5c26fa9cada',
    lookupId:
      '67fe46d62bfba6d5ff41651d5e40675b38faf94f0be96b227e9952082d7d99c3',
  },
  {
    providerId: 'PILOT-perf-10',
    accessCode: 'indexed-fixture-access-code-010',
    accessCodeHash:
      'scrypt$66395d88a95499cf631019553ed5060d$6dc5bfb0d470c9250fbc2ba15827195ccbb895a430aadf20fac0f95fc5d165fdd48b1303a2706c20ef4db63e95315559fe00cc7d3c8e86560a829a9aff96f4fa',
    lookupId:
      '852336dd8a93bcb8973f39b2a90701361e29b358e85813167c6479536910c1e3',
  },
  {
    providerId: 'PILOT-perf-11',
    accessCode: 'indexed-fixture-access-code-011',
    accessCodeHash:
      'scrypt$ee3174808ec728991957badd4e92acb0$c426b2bf059c49badd22e37911dac0d7548f23de6bbbf3f877c9ae8483bd57ffe2e5610b1fd32e22ff8984c77a0226c6527c9b7be4a7e444e469a0ad5427854a',
    lookupId:
      '6c46cacd21caec70930c45da6b48ca3aca5fffcfe44c95ead8f0af23fbd07d38',
  },
  {
    providerId: 'PILOT-perf-12',
    accessCode: 'indexed-fixture-access-code-012',
    accessCodeHash:
      'scrypt$f9565b785166788c251899be7bc2d16c$87fb86562d2e7e02ae0f41bbbb548cfc8e5b0c12b23b9c4bd13c202a64995fda41ab981c79a37a02ecf52b112abd693e9d042b5a40d11925ee2de51f1ea0568b',
    lookupId:
      'b4c7f7950170dcb33a060f8cac64f5055a975b99902f67fe72311f07af013673',
  },
  {
    providerId: 'PILOT-perf-13',
    accessCode: 'indexed-fixture-access-code-013',
    accessCodeHash:
      'scrypt$a39e26492b6a4cf81b2c0b2927cebae4$f857b2cfd96e11693bd73ee1bc21d288502093962d59f16e3513470a28178a555405934b23b8bd3ed29a00ef80b0f84b39fda5579948acce65a3cffe809c0921',
    lookupId:
      '3baafbbcf6114a1689bfba3cb94ea198db8e0e6f114f30947b22ea4e5c22fca6',
  },
  {
    providerId: 'PILOT-perf-14',
    accessCode: 'indexed-fixture-access-code-014',
    accessCodeHash:
      'scrypt$076120196e56974fe8e45d48b608d260$504a520be2a670f98531d6e46610a5ebc7aaade94a0275ac0312f13653a6e97a0a724abb23c9946140164cfa2c62c8177442f26659256e79f399919c60b68963',
    lookupId:
      '47a7987aff35dd6dfd60582ea322fe109a8c554d9cc6c21964cf9e6b7dde6919',
  },
  {
    providerId: 'PILOT-perf-15',
    accessCode: 'indexed-fixture-access-code-015',
    accessCodeHash:
      'scrypt$68ef8db6bdb946bba7b1cb2971f1b519$b57492446a32f53bfe6b141a94f89cf56b014a3033705c9916312d811bc22f4f20137167d323d713f46597ed3fdf1204627b63e3ef67b561c8c11c225d1a53b1',
    lookupId:
      '85f3aa14647da6156fb2c18cbc47b8121c111cfdd605681af18b1cdc1297d7ef',
  },
  {
    providerId: 'PILOT-perf-16',
    accessCode: 'indexed-fixture-access-code-016',
    accessCodeHash:
      'scrypt$a5e5d3173f54309e27292589669d6772$8314ef8ecbc18146298459534777cd90291db99dcc69d180b1793fcf1baed826c5da55f544d1f234176730d0ec9de773a4b6d16a65115f16184f2db1c8627ec4',
    lookupId:
      'c8ae4845165bff1078e91aa2ec38cc6255631d185c5bbcac072a3638c782544f',
  },
  {
    providerId: 'PILOT-perf-17',
    accessCode: 'indexed-fixture-access-code-017',
    accessCodeHash:
      'scrypt$76e2841abde1658cf5cb290d6f307ed8$4967519d348c9227e47d4d0178aba6e6fba3dac23fb4334c38c66fa03ae8da76539c2c7c543ef9e000cf3f412cc620cf8eeb99df0f4b882d66411a71210bfcea',
    lookupId:
      'be897f4e497a99c085a6f7667556c42b45d98daa4270065fba79c7ce04f5957b',
  },
  {
    providerId: 'PILOT-perf-18',
    accessCode: 'indexed-fixture-access-code-018',
    accessCodeHash:
      'scrypt$b4d1fb7be0039e30a7ac0fe6df6c2906$d32bdd839c780832fc4bcd3133a0084d86353a5ac62b53ea2c06c6fc763974090a6d0c8e32d7a907303ebe9087e39536cd3a12d34eaa064bd8f552dd16f21f07',
    lookupId:
      '35f4a866ed79992c4a2a21224a07ed14f002dc867bd38b10fc9dd7e989084357',
  },
  {
    providerId: 'PILOT-perf-19',
    accessCode: 'indexed-fixture-access-code-019',
    accessCodeHash:
      'scrypt$384c7ac8fd550cabd449cbad71794dec$7562b45376d3f49a57d34d421762794b143d45b4aad5de2d1cfd385c59c3b4f522e27e3638ce5746911e227b1f4c47dc6d679e25a8720f4d5332f318d2f64818',
    lookupId:
      '54f2b1088c9f133aa427e9887fc721e0f81a946ac19ccdf5694107a9b0c612be',
  },
  {
    providerId: 'PILOT-perf-20',
    accessCode: 'indexed-fixture-access-code-020',
    accessCodeHash:
      'scrypt$7d0b449b551099817d099838fbff1c9f$2a9d436e013b34705fe4e90cb79481581e58654c37a51a1f244c7450b1934b21dcd2e8c1eeef548d3e5ae6a6c64c861b3a9689d94a7fdf24091cfeeab71f0f2c',
    lookupId:
      '7f08467d8844c306e6406bd45c419619b213cd5b757ccee5ea7caef01e6ff9cd',
  },
  {
    providerId: 'PILOT-perf-21',
    accessCode: 'indexed-fixture-access-code-021',
    accessCodeHash:
      'scrypt$c6219db89c2093cf3305e416c193eee8$a960570479f02b2ef4c0b67aa933b3ecf67cc0c646a9c152da26417c9ccb7466928eee9d2975dc33b6462bfda8a1ddaea937a84a80c21d56b7a0f748543d1103',
    lookupId:
      '49055754a27fb519cfe3a3e917bada5078ed1636c456a7d731a4dba10e2c20eb',
  },
  {
    providerId: 'PILOT-perf-22',
    accessCode: 'indexed-fixture-access-code-022',
    accessCodeHash:
      'scrypt$905fc66605f6960a6ff154b08fcefcf2$017301ccdb8127b9a9b64451111565d6806e8ba33356cec6f5db7fa2aafdd2d0088236b7971b12ba0eb760ff762c7c58938352d0ae575c27d786445414d53ea1',
    lookupId:
      'd16057ec828d4e178af2e07b74bf13b2a1c6187a22f8d6262c4ec81af20ff113',
  },
  {
    providerId: 'PILOT-perf-23',
    accessCode: 'indexed-fixture-access-code-023',
    accessCodeHash:
      'scrypt$2c98eed8b2ea74aba0d3f8dc47536c57$80ab571def3b58b91d38dbb2abe21946c709988e35d8e7c4ae05cc2cbf46b598a6f26f838378781f6f1b7e2a090efcdde77b9a26e253682eb3a3519afb5d38d3',
    lookupId:
      '905acd5dd56f27a4ad0f6b25ad80c911951bb22e20eda49849128c7bfa566929',
  },
  {
    providerId: 'PILOT-perf-24',
    accessCode: 'indexed-fixture-access-code-024',
    accessCodeHash:
      'scrypt$0acdae4a6a5459a9566bc5e709dd9497$90f08210f850f4c49864d9ebd818847f3ef0e48e53ef1e359339920555ac38bcbbe39a1a8ccf15395839ac010b48eebbaa98fd7990a675954074c1be262bada5',
    lookupId:
      '6f9490c58c5df5140679bc2237e84a1c8f3f04bc82290bb6ba199e162ad717df',
  },
  {
    providerId: 'PILOT-perf-25',
    accessCode: 'indexed-fixture-access-code-025',
    accessCodeHash:
      'scrypt$65fb87e2b5667cd48a0e2bd0154bbc09$0532a8657febcb4a1a5b3d286cf4a56a9cb2c94b09ba64f526e5bcd03ff021a2f679ad3eccd88199501ede847c74b078dbb98b76202f92ef2bdd6a6c5f81868e',
    lookupId:
      '8d16c2889a8b286168ec07e9745c2f8ee3d88c66410a69883d4ce19cd6c93a1a',
  },
  {
    providerId: 'PILOT-perf-26',
    accessCode: 'indexed-fixture-access-code-026',
    accessCodeHash:
      'scrypt$512a42042828514121b2d52fff0006d9$ea62592ea262b7ca170afceab794229ea1bd127b9e94b01b61a1e4e7dc23097f9cfa225afdf506267210d32aaf4e42ef9d8ad7100baba0560e2f7d48da69f319',
    lookupId:
      'e6b03bd33f63e97cf22506652f050c4cf1ed4b40e1d308c50f58317606631971',
  },
  {
    providerId: 'PILOT-perf-27',
    accessCode: 'indexed-fixture-access-code-027',
    accessCodeHash:
      'scrypt$0c77708eaf24e74db8fb4f51039d1bcb$8c00e47f6b6eabf41b98f52ae38e55737ba1835ab655837b4b21f659bd42b1e48ad7ec2f02fb2750beb8835c17958621f53bca7fa3750f61a4f4be3a61d590c0',
    lookupId:
      '0b77473e9101dabf4ab4c171548dc6c57689127b5a06a406e1d20a460c5bc7de',
  },
  {
    providerId: 'PILOT-perf-28',
    accessCode: 'indexed-fixture-access-code-028',
    accessCodeHash:
      'scrypt$986c71bdaa4cd4044d4785856d25a085$cd586dfdf3ee2ccca23099fd1dd3a8b65d487c84bd9900513cdabc92d3c1713f3a33e0c735d588c3d92c67dce0f3d5998ad53124d91f10614a504150e966ed61',
    lookupId:
      '279c13d6cee33113176b2b149c83ca6a8dfdcc4c95431cb2944de9a3a86cb686',
  },
  {
    providerId: 'PILOT-perf-29',
    accessCode: 'indexed-fixture-access-code-029',
    accessCodeHash:
      'scrypt$2cc0eb6cafa9e1b6a6db4d9dfe1b01cc$9a77bb553027968a0b7d095215d7ab2c0765a47ea5248d8214665f5c8a88b62906bd63a9c801be1a2225cc99b3726b1e84d5c6c9054c40566b909e7b10b665e6',
    lookupId:
      'da379c4470415db07ce37faf2d2fbd531397a513798f42af50cfd2eaf3ac643c',
  },
  {
    providerId: 'PILOT-perf-30',
    accessCode: 'indexed-fixture-access-code-030',
    accessCodeHash:
      'scrypt$49bd8f4dae0ba1618f1fe63118a6071c$7063fd63467c37c1c1f1ebadf4c0b1bff679981340bc4a42b3796fcea7667866698c1239f215d66903353eccda23e7ab630a7ffed7ee345a3421687c908d33c2',
    lookupId:
      '5cb3365b50eb03ed4b86afc305aca0e4ed796b664901b874d5f528a962cab925',
  },
  {
    providerId: 'PILOT-perf-31',
    accessCode: 'indexed-fixture-access-code-031',
    accessCodeHash:
      'scrypt$c40cc62fb47f86e63d5f150f33da6241$5a98d659b29157fa9639e8868a07e163d1280ac22af2aa3d1c8158aa59b9eb77a60dad4df8c0355f6ca1cce45d40cefbaf9a9d220d7fedb20f1e3f462f45164f',
    lookupId:
      '01942c93f36b5252041e15fb4da56d66a76e5d5e00181453bb072e12a82670cc',
  },
  {
    providerId: 'PILOT-perf-32',
    accessCode: 'indexed-fixture-access-code-032',
    accessCodeHash:
      'scrypt$904885af2738df880b99f078a5d19350$1d13d88e34a888db64103bcba199306d457492c69bc21fc7a09dcfd29b4e5f281c68365b0a33e2250a211526dc2f32e34287ffc360a1f3f34edd07e21ae59457',
    lookupId:
      '0f27b3e29b268f5702e45fc1759e7f9d2bed3d5a0dcb81da595d958662ae1242',
  },
  {
    providerId: 'PILOT-perf-33',
    accessCode: 'indexed-fixture-access-code-033',
    accessCodeHash:
      'scrypt$d4f84b2ca7818192705ecddadb44ad46$c2c45c8481c0d3ef165c31895e1732d4882de68a918e0b3b02036b864328c0cdaa18ef77ac299f98b9d4abb7425509ddd13d9b76c4a531a002883865c8b8fbd5',
    lookupId:
      '6ff717c6067074d7aae4d90d03f6c4b1aa0f6f84c3a39905cfb7a35238b4d96e',
  },
  {
    providerId: 'PILOT-perf-34',
    accessCode: 'indexed-fixture-access-code-034',
    accessCodeHash:
      'scrypt$f349a21de76dbd5d290b631fc621e5a2$f1e8a3213b678f7ff2f0ec42c81c8fde82831ebacd610f5a5bce99922adb1d8ca132f66ef3628d364cbc8fe1ec32c9b7ca645155eac8bfd488a34d274a20efdc',
    lookupId:
      'e07785c38dca6d371cd8b31eeedb0a5276b5275beb43ca7d49867ab5c204d00b',
  },
  {
    providerId: 'PILOT-perf-35',
    accessCode: 'indexed-fixture-access-code-035',
    accessCodeHash:
      'scrypt$865acf45cbdaa7847578d4f7f5a58339$c964e4369073979f4a627f50a4c74025f339a230cd0739b3bebeb5bb44f43b7cd13b21994970dfa54e4bab17696ee9d80d8b3a967742d4b9130b5395dc8555d8',
    lookupId:
      '4a73ea59f572437716ce834188789953585085255a58107e9b94958cf562f3f0',
  },
  {
    providerId: 'PILOT-perf-36',
    accessCode: 'indexed-fixture-access-code-036',
    accessCodeHash:
      'scrypt$9a9c2619af97bedf66ffa3b6f0c8e572$c9c77394ead16b3d5fbfa3b80b62b775569b1266870db38f76aee8d743d8d0804755ba25134be874d9cc181e95a98144e2341913b548b2f66bb7f64052ca2dd3',
    lookupId:
      '722c33cf33d7d1be4a4db51078b6c491d94f4a1f35ecc517070595000ed977d5',
  },
  {
    providerId: 'PILOT-perf-37',
    accessCode: 'indexed-fixture-access-code-037',
    accessCodeHash:
      'scrypt$a55c671569a4f81fb130ac9fbbcb57ef$091407f8424bc9fdf0a15cb79995d83ba31718c1d07a104f753cb401fea0ff5a86e536ed9230aff298dffd9d2a20f1407425c05481a2a021bfe5d7a771b766db',
    lookupId:
      'e0de014f1c6b7a4401695d1120387e5f13390fa617c7238c5d2eac2b55eeffd2',
  },
  {
    providerId: 'PILOT-perf-38',
    accessCode: 'indexed-fixture-access-code-038',
    accessCodeHash:
      'scrypt$f4c88f99075911a3a112918b11c28b29$a1dacff78964e2d015a7a3461d86fd08d1a5c987eaab6559a97e73777ee05ebe7d886f44e3775622140e63eb820d4ce108950233cade407d51c269ab86bd9b53',
    lookupId:
      '2336eb9203135b076190243ea7ea27a1d1579fdd430f37822936a9ae19881048',
  },
  {
    providerId: 'PILOT-perf-39',
    accessCode: 'indexed-fixture-access-code-039',
    accessCodeHash:
      'scrypt$c673ec58cebd22cf87282368c309c9e5$81b6dbf036bbbb11d21d115ed0e6495832f699fef92f49e1526035034d2fe7007cdb6e29b608331f784fc590e6f7fdeb4b240b1bb68d24238a9068fcd0b7e2a8',
    lookupId:
      '51d005d479bbad7ff99542a52957dee39505f77fc1154250c4c3f15ebf8264ae',
  },
  {
    providerId: 'PILOT-perf-40',
    accessCode: 'indexed-fixture-access-code-040',
    accessCodeHash:
      'scrypt$d9cba0491dc86e4f2fd358ecca8d6416$b91457a73433485ac8d7a739b491e025b6bf7253f97e2e380736a38b4066b4c01969d8cdeae36f73db8f0186e844efa5ce61c1ffc392f165a1a5826f86760076',
    lookupId:
      '488b33ce00771b0a6075e3b54bb9316edcbc06cd94eaff52117a37658e81e51a',
  },
  {
    providerId: 'PILOT-perf-41',
    accessCode: 'indexed-fixture-access-code-041',
    accessCodeHash:
      'scrypt$ce48e29dba208667662a0bf86a2e1074$eef239cf1f7dc0823ec9e032530c237133030d45d1e9b0f06f962b4f100b9f603429b0c77e94d39d8566686953e1528db7ab5e43ce94b6e3bf552b8e092b3d85',
    lookupId:
      'f659bbb20413df7209f8d4639d82d83c688e03c8f0465cc305e175341e63e10f',
  },
  {
    providerId: 'PILOT-perf-42',
    accessCode: 'indexed-fixture-access-code-042',
    accessCodeHash:
      'scrypt$ed0c88f78cf4d1942d3f0b91b9694a49$156e40297dd1ac320b582049720c9e94092729cccee797ac9ce6ab4d5fa5553816630325fc492a266a1e2a2618d71ea047adaabf02ed2b068e7277a0fae1b0ee',
    lookupId:
      'b01719773467c029103cb9146f7afcfbaae006f549eddb5ca506614062f5eef8',
  },
  {
    providerId: 'PILOT-perf-43',
    accessCode: 'indexed-fixture-access-code-043',
    accessCodeHash:
      'scrypt$bcd0b133e506ab14b1e7aaf5fe243322$33785058bdd6e597f56e4b938b7ac3ccddbcd34ec384937f78a6de6e1b78905871387dbf9e5c280928d7c0464fe9cbf6167cdbe8ecc11cf5eaa868328a595722',
    lookupId:
      '6ff2bde62444f15059ae0bb10663318097fcd3ccc6b154f0dc7efb4e10a5891a',
  },
  {
    providerId: 'PILOT-perf-44',
    accessCode: 'indexed-fixture-access-code-044',
    accessCodeHash:
      'scrypt$66285b40ab3b5ddeffdbabe749dd3f71$1849bfc784af0372d5efb8ea2715478047a93c61d8fd32b20b21adb86cfeca10deae7ffe53bd3d29d1159bbf49610fc3c9e04f0c2544852de1b44c87967572bf',
    lookupId:
      '00a50001486fb40abef35cf852d6cc895e22357303de1486526e031bbfbb76be',
  },
  {
    providerId: 'PILOT-perf-45',
    accessCode: 'indexed-fixture-access-code-045',
    accessCodeHash:
      'scrypt$836acedededaacd98d248279b6913781$6b6166a9dd3e762cb8ab58b8b438fb2a64cc36c517214f76b6184317bac9b95380d191d0054a1cc6e6c90118bb07e4317ab1382690ae36d99f769a778f3934fd',
    lookupId:
      'cdcb309eb759525de03ef78693d98e644011e38e57f6daa9fda9cbd57068f6b4',
  },
  {
    providerId: 'PILOT-perf-46',
    accessCode: 'indexed-fixture-access-code-046',
    accessCodeHash:
      'scrypt$3bf56ed43a7d5a5a0bd2c6460f528482$5408d4705b04b4bd6f9814382a8dffee7d8a3dd7c5c76d36f744d68106de27e002786d9b8637d761168b702069235e73dc0e24a8294ad77412c492c4e4b5769a',
    lookupId:
      '6da889143b0153c3072810dacc5f9c1fdd622440173a35c058eb771b03493cc7',
  },
  {
    providerId: 'PILOT-perf-47',
    accessCode: 'indexed-fixture-access-code-047',
    accessCodeHash:
      'scrypt$60cdd94f83bb9cdacdebec931c8efe02$36b1b564db21ec7fc0d0fa11ce4309c9d685a2dc09d56efa88ad8718fcacf92a14fda803fc614c223861d9b0cdba4c34a1196e5cda19c9ffdafdd56a3507519e',
    lookupId:
      '00b5e8733fbd0df43e417f9ef4cff8e86c26952ff95e814f163f29c4bb6a8bf7',
  },
  {
    providerId: 'PILOT-perf-48',
    accessCode: 'indexed-fixture-access-code-048',
    accessCodeHash:
      'scrypt$6c007af5e49771d09238f9194d5d0abd$4d7f3bae95302ca1f8f2f8e574d6ba970f89f35b562acab3b4eb78c612fedd85c43e6eedd7568c17f40512922b3f836d28b721ac4417a77daaad03806902c1ef',
    lookupId:
      '77d72d0d0889b613c9338edabcb9b28bf14625289528caf8c69764b3ca3a47aa',
  },
  {
    providerId: 'PILOT-perf-49',
    accessCode: 'indexed-fixture-access-code-049',
    accessCodeHash:
      'scrypt$cf482e6d846d8c71ecf5f8cd4c3598cb$3b5aebe27be693c5bdce5f3d5bedf58b777c4b9dba47416ce94441e323ffe9aabedbbdcc769cb6326a0b99db19cb3ae5dd0e7dc46e50b86965f11963e1dbfff3',
    lookupId:
      '8700269bd62b82e8da9c8f280feb3378bf38727b8d6f3d331906e24b7a6e5904',
  },
  {
    providerId: 'PILOT-perf-50',
    accessCode: 'indexed-fixture-access-code-050',
    accessCodeHash:
      'scrypt$4bd309ad9f740589fc56523ad14da1b8$9346cadfac82c8fe97b7702cefdfabdc229440242f7886d912c4287269d95c02c123fce917236759b3fcc607346dcb52597a56fae429804838cde4f7ce4eedd4',
    lookupId:
      'dbbe27c9784fed368b7d1411312a8dbf37ce0a1ece2070138ab4107f96b67063',
  },
  {
    providerId: 'PILOT-perf-51',
    accessCode: 'indexed-fixture-access-code-051',
    accessCodeHash:
      'scrypt$5ea3d1d055068090cd71c2089068186f$88581a452e8054d70adc5517e407f28f235368961b496b42f3195d74d36ecdb6ad2d15bef0931db78835feac9c167edb66837272379fe5d806289950e1ff921d',
    lookupId:
      'cbf7a403dc60e7cd7bb82131d7237a73d10812b674e13f68a5ccb46e0d6b8451',
  },
  {
    providerId: 'PILOT-perf-52',
    accessCode: 'indexed-fixture-access-code-052',
    accessCodeHash:
      'scrypt$b7f34116ca3e40e8caee47edd66fae5b$0683583aed9fca85085ec2bebe07c7de7bd59481ba3597f7edc12654608294ff036ff25e6233e1206b193fb2ac999b747f980ab4f104759f595409961eb11cef',
    lookupId:
      '55862bb91dcb02494f0bb537798b665e2630b992bce019c5bb444bc1846fa3e6',
  },
  {
    providerId: 'PILOT-perf-53',
    accessCode: 'indexed-fixture-access-code-053',
    accessCodeHash:
      'scrypt$97c44d58bd1b739eeb42298ab0d6e357$5937fbeec4572d5237ce6fe0d7d6935d9f7fd069dcd5584dccc0db712e85855c0a6ea3d2af33a8f85935d14e77982807fe614544111fd0b3efa6fe4b398a84da',
    lookupId:
      '2f1fa5f2ad0ba846cde2e1b9b2c6dc3bb8ab0b2e06beadcc2dbe09f2b3e80977',
  },
  {
    providerId: 'PILOT-perf-54',
    accessCode: 'indexed-fixture-access-code-054',
    accessCodeHash:
      'scrypt$59de0d0e1a89ff9a4fb117b5a43fe74c$c3636ef0312a72dfbbef652dd6cc7531cf315937b5d28a37f4ba0ca5cd44747f218c0da319454fc10e8c5cd2a018ffccc66ab7c25553b3bed380cdb443ad61fc',
    lookupId:
      'ebca65a9167b0dc0998428f02fc4814d6d5277377f71bacfa7cf0c574dae0a4e',
  },
  {
    providerId: 'PILOT-perf-55',
    accessCode: 'indexed-fixture-access-code-055',
    accessCodeHash:
      'scrypt$12036d86d0cc49c14e7c323b19d8e709$c19a854841f323579fbb34d849ec076882a8853d370d7c74d50b7e970fe2baac0b9c231483b4c758e34cedfcaa5af3810cef98d1937becac34d55a237dd4e2a1',
    lookupId:
      '4e14bb634df016c9993081d69648018dc9756748314f014deb47343e6b977037',
  },
  {
    providerId: 'PILOT-perf-56',
    accessCode: 'indexed-fixture-access-code-056',
    accessCodeHash:
      'scrypt$2309fde10199daae08cceb461a81be25$a8f798f022e18e64b18b2c10faa1163f35673d0001befd7c0e90fb684e752c412c2e06a31877353a900cb90b12c0174c0a4c0aa5dddda638037de09becce49a8',
    lookupId:
      'e05bdf33b3a8e6aa36807206ecd3d56b09cbf6c27c62e785bc0d5584748a3076',
  },
  {
    providerId: 'PILOT-perf-57',
    accessCode: 'indexed-fixture-access-code-057',
    accessCodeHash:
      'scrypt$9198b88aef14721065e190623bfa56ec$b7ac9d6fec121a16d65b642b4519ab0b18bdaccde0a6dc4349bb847a3c472316e244749820e015c3224824f0e08ed0af3287ee1a4a43ca6f294433dc7aac8b22',
    lookupId:
      'd48d46615fd39f7188f8c8af2768f00d21c2ae9b038f2ef708248b2ed9e9e3a2',
  },
  {
    providerId: 'PILOT-perf-58',
    accessCode: 'indexed-fixture-access-code-058',
    accessCodeHash:
      'scrypt$bd4e1a888806f2c5142381ec8e03ad1c$eaea7bcf11742b5c7740fa6d00dc998fd0e3a25fc78da72691c840232dc87653a67c05e4e9086334456c6781e702c2c90922e36d1cefee8befe2118f79c1d666',
    lookupId:
      'bd29f658ff1ae6367172ed18c827e7abf9759d297980a5c98b325fa467b66e57',
  },
  {
    providerId: 'PILOT-perf-59',
    accessCode: 'indexed-fixture-access-code-059',
    accessCodeHash:
      'scrypt$0a64fc1ef83355c0350ee3591ea62364$ff0a173d29e3b0eb5ce1e88cc1cdb69dc43a34c84582897e52992a753fc16f146ab8f1c20df79da475183e15932f060da3e381aada4599167d056d4f6bef1f55',
    lookupId:
      '37dbb0d743d5ae356832f507fc9ba0e7d749b1c5028ff545721d85cb9edd7cb2',
  },
  {
    providerId: 'PILOT-perf-60',
    accessCode: 'indexed-fixture-access-code-060',
    accessCodeHash:
      'scrypt$ee0c9d7287fc39500396ffd1dd225031$e17db34d2f10c01668e5e5e76f76f9e0f5edc5ae4275f29c0aba816d7d0fd6b9991ae076513afd435a4c5f2806c3d23d5630a10ebcbdb77fe84757d055b217fb',
    lookupId:
      'd3a30aacd19245bd92d481adeaf1f4b594c083b5d341ac363975d2bb33898fec',
  },
  {
    providerId: 'PILOT-perf-61',
    accessCode: 'indexed-fixture-access-code-061',
    accessCodeHash:
      'scrypt$9cbbe01a9045eedd327beb92a50a9649$5e8190f5a6661bd55b7f16cc7e36447db32f0c57aebb3be8a97c1e2fd49fccffaaacc985a7b01984f80fa496c8c177c0cd81cc36fee71b23132d2992db819c27',
    lookupId:
      'a40c8f17a5d9c793d5a5dbeb0a4a4c486be36835d06aea6d6e21e504c692c4c5',
  },
  {
    providerId: 'PILOT-perf-62',
    accessCode: 'indexed-fixture-access-code-062',
    accessCodeHash:
      'scrypt$87c827fc075370713bdf244932b7b19a$b51378787a60df2b8cb470d1ac8d45d874f071761d3e5408abfcfa8fb049f0695393806d403576ed0576cf70549553b8c88df9298dddcbf2bf101315814a0ebd',
    lookupId:
      '97fd2379ac19d7e0da8a95262ca704afab8a2d4f9d03d8a19066f33be7b3721d',
  },
  {
    providerId: 'PILOT-perf-63',
    accessCode: 'indexed-fixture-access-code-063',
    accessCodeHash:
      'scrypt$7b907619554b8764a6a6e67833181976$0d2d51b53072052fdc443a005db5598fc123fc661c8da989a92376b509827419464fbea30751b828797a6def844c5a6d8c247c19c6c41182f733795e163c6b44',
    lookupId:
      '9ab85ca9e02cd33aa2822c75e9b28da65341d93afbc45c5225dd593f8b48b2e9',
  },
  {
    providerId: 'PILOT-perf-64',
    accessCode: 'indexed-fixture-access-code-064',
    accessCodeHash:
      'scrypt$79ad7f04f8dd89127b71a39633bc4691$8cc73906d2e74e23843b9008c3c36fb02d213526c32bafef165c359105834c3034f23bb0c8b11388c78d939b71c69040423c64c9f19bedc6b5c80cc9fa3de5a0',
    lookupId:
      'e1067825e4faad180687427d4450ecd215c1ac0111630906c7db8de724e248d1',
  },
  {
    providerId: 'PILOT-perf-65',
    accessCode: 'indexed-fixture-access-code-065',
    accessCodeHash:
      'scrypt$b924844d7c888b1f1408d6a0440acdbb$6e1a7cf1042ae8c8b3bfbfe6735b6126bb4bdf6f83615f8e8114874ad8c2799d620bbc4e641580a11afd531a306f5dd741b9c4f00f8a9a5fc03485cfac1b3b8f',
    lookupId:
      '4b4faf371a6b1e316f4ff4c4804dbcb62b4dfacb694e0c4253af104319bde5b7',
  },
  {
    providerId: 'PILOT-perf-66',
    accessCode: 'indexed-fixture-access-code-066',
    accessCodeHash:
      'scrypt$779dfcb268380742cd2a2c31f84ca1ef$a048a0587edfc51a470186ef8be97a762aa4455e754b796262f9fb0f136308350c04cac8ae73f5723a8cdc10bc27a4b2e1ed143025c192053f58c8178f98e182',
    lookupId:
      '91418fb5b564f5195e616739d4e04d5c050359dbefad4f944ccd77c209b313fa',
  },
  {
    providerId: 'PILOT-perf-67',
    accessCode: 'indexed-fixture-access-code-067',
    accessCodeHash:
      'scrypt$93cb2807b1ed1d9e3386a85c56cc5313$f0a7d8201ea2312c2344fc2aed3508aa12169720b70c376d2eba4ee71c858dc719090cf1d6dfa1d5cdc0a037f4d7582df6e88282bc76274c55c02a8743de1a7c',
    lookupId:
      '79cb3d39ac83ae7e623b853b2cf408e1021c99b3397d4ef4e8d3b62cab77b4f1',
  },
  {
    providerId: 'PILOT-perf-68',
    accessCode: 'indexed-fixture-access-code-068',
    accessCodeHash:
      'scrypt$59073ac7f6d99de473a63097030ac308$2f395611d6d12669b310b70bc865414cba252f27c9b37df2e2e8b8acf63015e0e56944ac43ea6003adb4321d7808314b6d13f17702bcb5190b6f19d653ed5f74',
    lookupId:
      'f7cadc6ea3ac996c8ae2984a757a39d95fb9a0523b2a4c60e0151611bc4a88ba',
  },
  {
    providerId: 'PILOT-perf-69',
    accessCode: 'indexed-fixture-access-code-069',
    accessCodeHash:
      'scrypt$4e5bb61b7c5c38ddccbddf2b1b51eb61$0e21bf9f0e5a2d04bf4a8de010c4d9e465826f215ae26bb76f5d38549cf0ad0269b7eb9fe7a7fe5039becbaaac1e723b23aa0b925d6547318150c6278b74b7b0',
    lookupId:
      'dcbe12f7134766f5135ea718719303019f30edd9a196cea8e3142073adde122e',
  },
  {
    providerId: 'PILOT-perf-70',
    accessCode: 'indexed-fixture-access-code-070',
    accessCodeHash:
      'scrypt$909c2156e1e83559642e4e801b7cc7a4$fa84cd6959e2414da94401a95085518322248f4064062ab5988cb2c25405c7249bd9a2ad6d7f0cbd954526841d58608a5e0f5695eca5a7c9bade5f84c255a908',
    lookupId:
      '2bac6d0c2038cadaa81622706d33aa0c327bc0a0045b468e8bca005cc724cbe4',
  },
  {
    providerId: 'PILOT-perf-71',
    accessCode: 'indexed-fixture-access-code-071',
    accessCodeHash:
      'scrypt$99826d791d0a8aae2693cb8ef7a9b14c$9b566326b3bbad6a88691f7bee44ea31e6f719e71a23130cf5ba58e34bf5c429dfecc4a2289456995de946214e0786c97c45bb53d2ad8bede077a4c015c8c3e8',
    lookupId:
      '7455b83012282b94ee42f48ec0a260872e817aac6efe5da84ffec3d7132bfdd3',
  },
  {
    providerId: 'PILOT-perf-72',
    accessCode: 'indexed-fixture-access-code-072',
    accessCodeHash:
      'scrypt$45ad0a4d9bc70dd2070219c33c41af00$efe3078ba93ceecf7e363c7e6e0dd54d86adf3ec1b9f3537ca4318fd5beb0d4aec058d945b9f5b36b48f3aab599823861bec557f2313904b99f4fa525ed9d1cf',
    lookupId:
      '51b21edbd342fb48118e3892d898fe4b2d28255195ba1e3f4920b405321622a9',
  },
  {
    providerId: 'PILOT-perf-73',
    accessCode: 'indexed-fixture-access-code-073',
    accessCodeHash:
      'scrypt$de8d2a49fa69cbb95def738cc8d21f6b$623f9b6d9c1f8e5be1e86ee989f7c7e51835c338d00f3c63a875ed32e7f80c25ee6f029f605b829e9fe2be325847d7cc5037cc59ceb7509268ad0b0456675f2b',
    lookupId:
      'a1f0213eec21cc91954a424145afc8a48d72c6a2c10e7c675e9bb4079db293ab',
  },
  {
    providerId: 'PILOT-perf-74',
    accessCode: 'indexed-fixture-access-code-074',
    accessCodeHash:
      'scrypt$acf6d42677cff24b86e3fe65bb44f9e6$95a31323521728c07e5e36d09f251a83d4750ca28f52da7bd01837d58fa3cb790d842cfb878d1a2d5c13da6a9a0eb578c7f384a86892905778d1e46a117afe5c',
    lookupId:
      '8cc5acdf435e589f46a4188ef0cd1f2899ada39272747711552fae2fc1dbb387',
  },
  {
    providerId: 'PILOT-perf-75',
    accessCode: 'indexed-fixture-access-code-075',
    accessCodeHash:
      'scrypt$75730360aff1c77da876772b7e415628$94132054352a4c2c1682e7633acf2c3a964afadbde4b29e087d8664afb0c1ede3c7009016d92a9e5a98e5bfbb1623b22367126d8dba59c35a21cd2836a878f20',
    lookupId:
      '1dc2b9e6789e269f524470615458fc996f7b17e4dc772d0d143a2314f65be411',
  },
  {
    providerId: 'PILOT-perf-76',
    accessCode: 'indexed-fixture-access-code-076',
    accessCodeHash:
      'scrypt$e53f4ae3cd3d12558f722c88b246cbe4$8c869719107c1038b8500cae03be810f2a2d484f06051b252d7ad2a9cc07e98ba0919b8d16114b0fec9f3e81e940003595f3656919a2dd27664827b192955217',
    lookupId:
      'ebf506bb3e69dfdb565b385b52038e6c9c725776736ce37c3bab022b2197ecbb',
  },
  {
    providerId: 'PILOT-perf-77',
    accessCode: 'indexed-fixture-access-code-077',
    accessCodeHash:
      'scrypt$15c97457c26510d27de5bb462934de81$ca0ded18c84f1e05b2ff896fb5e8c8a9845a4b28e707d2fd85d625815652c48b465ceaf0f92b97c15ca981c545127031927204cd6a83c345a355c142e1d97d7a',
    lookupId:
      'df7587487104c0fd81b48348dcd4d85e0e711976fc8ca6f99f5b09443a7335eb',
  },
  {
    providerId: 'PILOT-perf-78',
    accessCode: 'indexed-fixture-access-code-078',
    accessCodeHash:
      'scrypt$08657d9e3999a41b669f4b0ab5a1dcac$9d1d36d3bbcd62d2ed0d58a5e155aea726dfc124eb0736981383261446456e2eb50a858c277e2520561c2f4c812c3da21e6f75b664b6ec1e89200388cb71026a',
    lookupId:
      'c8bfd4bcedde00350d086b36a128abc4dba0f6db8bb77bc6d3def1503195434d',
  },
  {
    providerId: 'PILOT-perf-79',
    accessCode: 'indexed-fixture-access-code-079',
    accessCodeHash:
      'scrypt$728130e047a150cae2e2846f4518b1a5$6c9bb4901779cf499f39658af5aa1650d4d138ea99a617f671f2a7453c41f43da79f8aa49ce2eed7bf7a3a6238ea737d0e8424d4c5e36f7ba4f15a7ec324da7a',
    lookupId:
      '868d36dafb12139e9a6f34d594320851254f922cf4405ae975f68b53ab4c4fd4',
  },
  {
    providerId: 'PILOT-perf-80',
    accessCode: 'indexed-fixture-access-code-080',
    accessCodeHash:
      'scrypt$8233228305d6b496a1dcda68e43584f7$d520abd50728ea670dbdaf7b5dedd130ffe72f74ff980090836482308b0c701d4249d277e20bdc16b18d94e63479bdfe5982fbd048ced01455edc4ec10f6ede7',
    lookupId:
      '55645a9ecf406127efbb0787911d1e6e4fc737abd8b24426e45226c74a221615',
  },
  {
    providerId: 'PILOT-perf-81',
    accessCode: 'indexed-fixture-access-code-081',
    accessCodeHash:
      'scrypt$77e0b5daecfe24174be2208aca57b85d$06d837e9741e0ad4544f75a3f9a163ffda5ca6946972d7bcddd80c81b91ec58e93171b74cdb5f18e9d7a066b436408e03f54d9f706e1d56288835defbcdc8d8a',
    lookupId:
      '4d73afcd52ff429161c808e59c0fabba835708e6de8f90dce1e04816eb2fe882',
  },
  {
    providerId: 'PILOT-perf-82',
    accessCode: 'indexed-fixture-access-code-082',
    accessCodeHash:
      'scrypt$87ec7ff68e0a3708bd5ca19712f027a7$42238efd50b1d5bd05dd724d9b52d3bee821c4c060b54b17add42fbca81ebf1c119b31dbd5761d63db6e04d366fd169c7375f74afd97a65c42298c7aa49040bf',
    lookupId:
      'b9d2ae3b70b8bfa44dd2c541d0b0c35d4c11de52c9424e7e560f796331ae1c84',
  },
  {
    providerId: 'PILOT-perf-83',
    accessCode: 'indexed-fixture-access-code-083',
    accessCodeHash:
      'scrypt$2843af76dd52731d138dd70fd20fe045$2555434c676df42ff99106dac9ed124a57ebf5d8c27a31f9d459d29b7e58b0a89d8f41131a4a385c786ea9226b04514f1714ac16034769865ae030ba6ef96fe9',
    lookupId:
      '801b9cf1ccbf9b68a3bc721ca7c1b212caf9a12cd62089614627c8b38f5e4882',
  },
  {
    providerId: 'PILOT-perf-84',
    accessCode: 'indexed-fixture-access-code-084',
    accessCodeHash:
      'scrypt$7b57773be6fee4992e9afa860654022e$9bc740dc624ca6ec68950741ed8711a57efabfe0e9e5a3986f502c6b1c7807b74c080213ff7a5eaf98a46d139bfd654424527031bd6d412a4486f6b535aad1e6',
    lookupId:
      '6d2ed2fd4a34d9f98f9a14a076fa03181f4400c115d5a56123cf31023c7b507e',
  },
  {
    providerId: 'PILOT-perf-85',
    accessCode: 'indexed-fixture-access-code-085',
    accessCodeHash:
      'scrypt$a36c335ba08420938c89c00e57c3ba65$c53d3e79ac9bcafee2450869edb5bb4c12c28e1de08c04f33b21a224f9b7cc8c8a980eb10029da47c029200db30b2040d13958e1a52edae876926ad7e59b4649',
    lookupId:
      'e289329746f18b30af401ce278d239996dfb15845190793af724754930dd3559',
  },
  {
    providerId: 'PILOT-perf-86',
    accessCode: 'indexed-fixture-access-code-086',
    accessCodeHash:
      'scrypt$2df859219eae487aa4437692173ec12c$63d529810e781f0e78905ccf964f5ca937e3d63f7e7869a520c629a77958aadcec76ffa3ff0cca81b0449b430e44fa27d94f8331107468edbb7626bdba36878e',
    lookupId:
      'cb068024080c9d886cc58f8a0fb43390ffd85bd8537c49495069da8357edca6a',
  },
  {
    providerId: 'PILOT-perf-87',
    accessCode: 'indexed-fixture-access-code-087',
    accessCodeHash:
      'scrypt$4963ac5b1366b53eea72443e0f8485f7$c3ea5268397c659ef9819f4cef2cdcac0b2a88090683505f1dbd3c10432c06dbbae1dc0e3ae878a7aeb1d7f9b1c16b9aefd4b5180817f4d4645dffd21bf53c13',
    lookupId:
      '30d9a6c762da9fd75d7446d7115a7f87585fa9922a2847261c923f9f62a30bd6',
  },
  {
    providerId: 'PILOT-perf-88',
    accessCode: 'indexed-fixture-access-code-088',
    accessCodeHash:
      'scrypt$713ca18dd1cef42c198f50a8e066b9db$d09b142793b3fca7b48a4bd8d33e4c1549ca598ff52684281f7eb00925df1156f624849bb457c35622fadce3f7fcbcb1ca0cfc7f233767b40eeeb4021005d99a',
    lookupId:
      '7232f2d3cbcbd5fde427b9303ca77dde12024a0c21fda698bfa968252769993b',
  },
  {
    providerId: 'PILOT-perf-89',
    accessCode: 'indexed-fixture-access-code-089',
    accessCodeHash:
      'scrypt$8107c671bfe670c05253db655d9b1464$a39d48e456e0a8e32ba75f8cc204f0d8d0770f9994c075cac94e919438caa03f066eced1fa26ea45f38de23f53b797423b51cc47c08adb9145a5636396393580',
    lookupId:
      'e1812e23b6cc1fef775c102ae28e3616a685d3bcd366d16c071f0f8851360d6f',
  },
  {
    providerId: 'PILOT-perf-90',
    accessCode: 'indexed-fixture-access-code-090',
    accessCodeHash:
      'scrypt$350f6b91b91248a457e95ec1bad91853$44d9b47002517513998749a6effd2f9e02b4e651fcfecb17fc22ba6b7356c67cdc363389093611ac7b1ba63570c73ee058e2846b43da41d2fc9f8a4cd48a668e',
    lookupId:
      'e7ec836429e9ecad186b5024657bb0d62e076531bfc391f411285d96a4485267',
  },
  {
    providerId: 'PILOT-perf-91',
    accessCode: 'indexed-fixture-access-code-091',
    accessCodeHash:
      'scrypt$2c8492d12c77865fa388f378a19cc4f9$8fdf726b673d8ab2e374f457d3e3d56117bb9fe5a79cc8bf2d6aaa140a9e9c21c86ff948de20ce4e0d78f18f253925adfee2ea77f5143afeda81485f1348a8ce',
    lookupId:
      '97ab62e71f8f43c8cb13ac9478ec48567d09b135a6648771b0a03fff85d5dd9a',
  },
  {
    providerId: 'PILOT-perf-92',
    accessCode: 'indexed-fixture-access-code-092',
    accessCodeHash:
      'scrypt$9b9f7120989126121159bd6af132a552$58e75750a93a2cd2942f0aa872f85dcf0a8e056d8f3e614fd4ad19e2d466c1d254e9805c9489ccc654f1e1f2548e1e33b18bde6b1b2558d3424888e2483e8c5f',
    lookupId:
      'ac07719c4bc7373206f9ac939fb61c8e738157b96da5a485581abdeac7510351',
  },
  {
    providerId: 'PILOT-perf-93',
    accessCode: 'indexed-fixture-access-code-093',
    accessCodeHash:
      'scrypt$45cc041e051fa973c9a8d99773bc1e6e$1cd3dfd716320f083048e40a3614a9936d971c922f152b06d960f533043f850e662971e07bccf03035eb099ad30c4806bc8254aa9b19d48b2f17a588a57c158a',
    lookupId:
      '4dd754d44d28d9efdee4212a2fa7e8f7f47fe307b81d78fd536609d434b885c8',
  },
  {
    providerId: 'PILOT-perf-94',
    accessCode: 'indexed-fixture-access-code-094',
    accessCodeHash:
      'scrypt$7f13e45ac64c2f13fb63d43a25402411$46b9c452783a7fbfd93eb90a070698fb8102725d71534e89fb13bad15c9eb27431e36123f501cec78c75083459461993879b3879c116217f1a63d3beb4f94501',
    lookupId:
      'acb4bed8bfb499285b0bb5451a47f7685067ffb9a1aa22c718e6cc343e954707',
  },
  {
    providerId: 'PILOT-perf-95',
    accessCode: 'indexed-fixture-access-code-095',
    accessCodeHash:
      'scrypt$5860f479a9d474cd9f917502fc4ae289$4ed28d6abea10c82c2d68053e365749331b384a9ed04c3aba1827a66b5060dcd54a0616687831d60c060b92ccfd21326baf752eb65acf8b99dfd1ce3987d4991',
    lookupId:
      '959bce1def2059066bc228de0c4391b3c43ecb081e79a86ddf4f271e305c46d5',
  },
  {
    providerId: 'PILOT-perf-96',
    accessCode: 'indexed-fixture-access-code-096',
    accessCodeHash:
      'scrypt$6861ed24b5a05b2315f2d63ab5139b2f$8c66d93d445388f094e3e6207272620b53ac0b21b14048c02f3ca764eda403a635edc5213b22dd23f03acab7801f1f2ee2c2eae36ea763f5b455e6f85dd1e9e3',
    lookupId:
      '87c5c979ee00d59f4a19da7e4ec7e4c6ed0456dc95cb061b3a6e79b250764a9d',
  },
  {
    providerId: 'PILOT-perf-97',
    accessCode: 'indexed-fixture-access-code-097',
    accessCodeHash:
      'scrypt$84ed3bcf7771568fc7c3b1cb49c1ac9a$663e48391353255656717cfdef01797ca3bc4f58a60431339a536b1c1b2a45a481ca0b2709d1007a6edbf4273c1b049ab4e3868e4df6139f694b78ff1906e60f',
    lookupId:
      'af60c0ad3379afe8ea048f6ebc0b9978de7171bf68d388fa1eacfdfd7f64597c',
  },
  {
    providerId: 'PILOT-perf-98',
    accessCode: 'indexed-fixture-access-code-098',
    accessCodeHash:
      'scrypt$e41c58c95fcf49a8caccf18402bc7d26$0a18cfe265bc05df3e724fa798953a82043931e15d50c80382d1837fbb98160f939b0d896e306f20c12db5a8aba65e7d43a0f5c4efc68fc44404a66ef45297c1',
    lookupId:
      '5af4f5c4fca48d8c6ec74f8fa98b2a26c8372cff19202da13b6b7ec90d303717',
  },
  {
    providerId: 'PILOT-perf-99',
    accessCode: 'indexed-fixture-access-code-099',
    accessCodeHash:
      'scrypt$671e903ee93426cc8a8e35b4aa06f664$fc2f7c434cb9a1327b8f765a493a3240d3b2c86598dc9d3508e86cd0995bdff917ded808f5025a7dfe4952219cf119f6628a5f1fc8447784480c48a1d0abde10',
    lookupId:
      'ebfa3830a231f5033c996ece31297c776de917ada7c40c09df052638a8d57eaf',
  },
  {
    providerId: 'PILOT-perf-100',
    accessCode: 'indexed-fixture-access-code-100',
    accessCodeHash:
      'scrypt$e1a1f2c8e69fd2a64aa59f27424cc259$a32df19503bf116e2738071f26dfa532f08d37ded396a50c0658698e0c63b809ed2a621454c2f1b5dbcbb3c16d319f97f40ca8dee66069f848ff5b53aed204a0',
    lookupId:
      '63e520d923f51b57966ae459affe2a24e79af4640d24ac4a7ca96f9d9051951a',
  },
  {
    providerId: 'PILOT-perf-101',
    accessCode: 'indexed-fixture-access-code-101',
    accessCodeHash:
      'scrypt$0a4abc1bee738ee5273b85c1d6e761e1$ae387172b4cf1907da1d2193429790d54faa91edfc3b2e86e08ebf22486efff33ed2f0b46017806ab4a5ded1a36a0d0ec9e496e80aa7abe187a2625d51bb4244',
    lookupId:
      'ba123de9e2058e4f1a0845497825dcf0d9017f71b29d19da4dd8fdd8c8169048',
  },
  {
    providerId: 'PILOT-perf-102',
    accessCode: 'indexed-fixture-access-code-102',
    accessCodeHash:
      'scrypt$82b64c105f0e133d9cfc10d4afad38af$afab6af7bdac058672862a09091d1e8f33c97a5149cb1848472d2a9326dcd21c03eb0886d47c24501c15a79320ed3161fb93abda4414c3291f2a041d0d00622a',
    lookupId:
      'f262658d51e78e16b52b4cc4ea9a5bdc473ca39dbb26238bd884e87297b51fee',
  },
  {
    providerId: 'PILOT-perf-103',
    accessCode: 'indexed-fixture-access-code-103',
    accessCodeHash:
      'scrypt$0f4c4e7a3848c9bfd33b44ad8769bccb$85ccf69031f9bfcf925724992099891e90405def77784c36132e0af599f329574fc6fdf1c74f12c0d225c2156b31b450d305548d93ef1efcbad7bc33cf0c949c',
    lookupId:
      '8ff9b26fd5842e9105c39291e204e143a1d8447a0b88678b3798b8534ab98b1e',
  },
  {
    providerId: 'PILOT-perf-104',
    accessCode: 'indexed-fixture-access-code-104',
    accessCodeHash:
      'scrypt$fbf0311580659de458ca49981fe7285a$0f3a035024c26c622214028ae5dea2c3da2159858c5f3871476b079dfc1d051a36c4f0103318999f60c46abcea455cc14d1f25354055ed9d9661ef682da622ec',
    lookupId:
      'ce045c24edb0d90d9d9d73fe39a2d69ac268c8d60537d02f1e0888be574d38db',
  },
  {
    providerId: 'PILOT-perf-105',
    accessCode: 'indexed-fixture-access-code-105',
    accessCodeHash:
      'scrypt$d087c2cce784b6ee11479b4ff1f16117$42f644ca8037a7866e17089f3b2f0827d584a369a1177dde408e404b6520a008d4ffdb94dfd0ce0fec13af288c075ecaa02a8b280b38f0e6eb101bc57c62fa09',
    lookupId:
      '8d394eca3a9d5631b06b30808e4298d3a3ee1fcf5b9471b4d626d324963d7fe3',
  },
  {
    providerId: 'PILOT-perf-106',
    accessCode: 'indexed-fixture-access-code-106',
    accessCodeHash:
      'scrypt$8d5890eb9a32f4b30e8adbf2c04c10e3$3f9bd3bed28c3e0fdb166086175fc65bfe0bac9aa625187eb8eb3d7cf8c84a72713d7ecd140381390a335d13b363165e49f5e507138740c23e373615edc2165f',
    lookupId:
      '185bd1a3d1c95aa4f4abc3d856c2a15011b43bde1ace4d0e68badc6fd141150c',
  },
  {
    providerId: 'PILOT-perf-107',
    accessCode: 'indexed-fixture-access-code-107',
    accessCodeHash:
      'scrypt$ed4136d77e24a7cce13f8a80b2abc5d5$2e1b4ae30799df350ceaa830ea9e6e5633b4d864fad3f419fa94053e9ff1ac5116c28f68a28e82ac64260ef4e19c3b3d31a3f668911d6c11e6ef2433518b246a',
    lookupId:
      'ce8aff6cb805210e696fd6e07aa78004f3d52cf9daea38281dd3600637ce6985',
  },
  {
    providerId: 'PILOT-perf-108',
    accessCode: 'indexed-fixture-access-code-108',
    accessCodeHash:
      'scrypt$b270ab578549302c7d3f2623aab311d3$2921e4e0cef836aa97efbbd60514e8382103763bf7d11dc8b2d860e7946ed0a750acf73480b45815f324bde80bde25c158c8145ce9461572c06351ee692fba97',
    lookupId:
      '12590825f91fe9158d7837d5853be61f6ee1b752a43c1721ed76cda4c7a5fedd',
  },
  {
    providerId: 'PILOT-perf-109',
    accessCode: 'indexed-fixture-access-code-109',
    accessCodeHash:
      'scrypt$b5eeb3497bad24a5a5d1c401e98f2ba6$b980f299bd93351b89d46b516718ec58e51365334cf5cafaeafb5f8c107dba0cd5256c0effb1c747a857ac7a5cc94959c42d9797cef8b59cb8922812f77529ed',
    lookupId:
      '2aadd58a635f868d86653d987da1ba57cd2458151d77e70bf0d55c23c66d46ce',
  },
  {
    providerId: 'PILOT-perf-110',
    accessCode: 'indexed-fixture-access-code-110',
    accessCodeHash:
      'scrypt$abacbb43788bc224784003149a04e1ce$1971b59a504fd85bb9ef09bd9134802137eb806eae914e8b82eff5afc9cf7d02201cdcea83c29ebf99316293b437a367d14f336e336c0ea9342b1fb73443b4e6',
    lookupId:
      'dd4b4bcdfe7d486a4be096fdb20ef3ab9ae39faed4d6686c7955eae679fec270',
  },
  {
    providerId: 'PILOT-perf-111',
    accessCode: 'indexed-fixture-access-code-111',
    accessCodeHash:
      'scrypt$d81f67a832d719092867d1e8c26eff90$3e1d2583bd4755104cc6df6c40c5981bd6ae5842da39ba1f43714c0483a5d9fb5b7524b2d783a0eebfb7d277cb757a2930efc7bd4b02cc7b7755759e948a3083',
    lookupId:
      'de71815a8ced3f1f93788ae703e248abdd9e924a0ebd1541378631dcf4d2ac06',
  },
  {
    providerId: 'PILOT-perf-112',
    accessCode: 'indexed-fixture-access-code-112',
    accessCodeHash:
      'scrypt$34bd7d189c9cd89ee4d5e80b0fcbc542$e0b3474de05b26c0ba85cad868657f47197df4a6813277dc6a94b4b6522775096af19edfbac0c36199e828f00a172c982d26310c984757d071e0941823bfcd68',
    lookupId:
      '2d75ab6f73ba8d83ff7ae2611fb94d8aadce80884b25cc6e4ef540e995ab0e82',
  },
  {
    providerId: 'PILOT-perf-113',
    accessCode: 'indexed-fixture-access-code-113',
    accessCodeHash:
      'scrypt$0c710d1706bb8bad275b70abf076343d$fd711f96b1b738ce6798af096ab914cbe7858d021edd63e9b21e96b6a8bc2ab7bcb6abb991e538bf71d8edd7e7a3fe2b1d7c6e0118a38fe339ef709edfdf8046',
    lookupId:
      '61c2b2db47b857753e4ca56b57b31b9c20c68141edea31a60c9f60ecc7fa0635',
  },
  {
    providerId: 'PILOT-perf-114',
    accessCode: 'indexed-fixture-access-code-114',
    accessCodeHash:
      'scrypt$ab9e840704d6ac28bd2856c523e06918$843b74bb059fa2a297c4b75b8340d008a1938031ca83ed27ae1916f249f430ba270fd265f3138415f4b54fba66a1d670245021c9da257e8bb9341e13ab7aecaa',
    lookupId:
      'd31a76f75bd3ac80c08d6def90ba1b669ae423f7e77bebe2399275fba594cbd9',
  },
  {
    providerId: 'PILOT-perf-115',
    accessCode: 'indexed-fixture-access-code-115',
    accessCodeHash:
      'scrypt$ca3c7fdad9d1fd254d4d857d2c2fc6f3$804e0de79237cf8e78ae58bc574d16fdb34eb7adc2515d5596c6c2236976a563e51e13c58a45b10b2715cd38393e6b00d3646968b6be93511f51da96b646fa89',
    lookupId:
      'fa1e2dfec9fb9501394bb5aa9946707186171b11c4741a8826cbde7b0798fb86',
  },
  {
    providerId: 'PILOT-perf-116',
    accessCode: 'indexed-fixture-access-code-116',
    accessCodeHash:
      'scrypt$c7e792874edb5ea863e9b717bd538c8c$3c9b85bacc063bb2a0356a87ae77b8c4bcd4fdcd1c89f7cb1228ccd0e8340e4b3ce0b2ccde3615115ae8e24eb3b1194ff902e9166f6e6502acba77f0742be590',
    lookupId:
      '37a3c2fb6c5f6134704532855581eb31055429a2d6c5a405d6118f900e901a63',
  },
  {
    providerId: 'PILOT-perf-117',
    accessCode: 'indexed-fixture-access-code-117',
    accessCodeHash:
      'scrypt$88fcfe39d5e86ca960a40151ab45c835$6fd045a2da0225cf12aaac1a4b9e1633160f4f99cf48c128710f6b319a04d4bf574bbd8a8f20713eef7dd62efbc9a8e90655d0c88a8aabead90be7efe9be61d9',
    lookupId:
      '5383984cde1881cb0df8005245d7b917fd1b3cfb5edbd7442e175bf623f2caff',
  },
  {
    providerId: 'PILOT-perf-118',
    accessCode: 'indexed-fixture-access-code-118',
    accessCodeHash:
      'scrypt$992972ae931817ccd2c9cae2ae2f0992$aed1663c6ed9ab14f3cc9743fac8895d068c592d7c16d884f2144671be1443d494f80a3032d16f1dbad7dc2b26f4095af0227241682b859b25d564e2b703f827',
    lookupId:
      'eea4308f860149b2763185efeddbff239a673f13c22741a736599fb25c78199d',
  },
  {
    providerId: 'PILOT-perf-119',
    accessCode: 'indexed-fixture-access-code-119',
    accessCodeHash:
      'scrypt$d01dbe0c9472cc82f50ac6ddb4d5579f$0b287e859ef00661a2470ffc23c2119b28e886d70794e5db407a89592a762d7f7d8720b10e1c29394c43c1941b7517c96c1b9ddf42d46237b4e813449e598f98',
    lookupId:
      '60e8a796631c664a87a72e54964f10eae208243c2bd96943e8e5bc7707483b54',
  },
  {
    providerId: 'PILOT-perf-120',
    accessCode: 'indexed-fixture-access-code-120',
    accessCodeHash:
      'scrypt$8d71b067e710dc4ff64ce0db23eff158$3a358f76a6b861aa6b72e4f1389172535f01576cd7a9c30d602b98630a87185ced0eaf1bb5a88c54cc9c9de1ba89d1da8dc1a13be1c9778827fa793ce0acec1a',
    lookupId:
      '87a5442b580853db83a4c3112f76516947e941723dea879f9f8f16a32aa39ed0',
  },
  {
    providerId: 'PILOT-perf-121',
    accessCode: 'indexed-fixture-access-code-121',
    accessCodeHash:
      'scrypt$c5632473e51e9207fa4ee228691e89e4$345935a4e7faa8a270cab86cc8c08705a16e78144fb340bf56c53cb839f7c9b909e72d2cfd901b5876481f61dddd057a336129648997faa62db1e264fcf02660',
    lookupId:
      '70cda6dda94c43047e28dc87d33172edb91ce21c902041fd69ad7f0cb14a229b',
  },
  {
    providerId: 'PILOT-perf-122',
    accessCode: 'indexed-fixture-access-code-122',
    accessCodeHash:
      'scrypt$3a9ad09aca514035b83f3e14e77491dd$afc64bc5292c65fdbe0333a0b1e8f34912051a578a7211df70c7aba4e94dad602b35ffbd1f6ab37033ea0278c5ee7add76da664e2143bc00275ef14bf12a9067',
    lookupId:
      '0c2627128d70fa174597621a858d087021fdfea50a73a5ec81b750e564c87d55',
  },
  {
    providerId: 'PILOT-perf-123',
    accessCode: 'indexed-fixture-access-code-123',
    accessCodeHash:
      'scrypt$d84e95e6167eccfc9368cf0ec857f6f2$84341c65e2395bf0f18b2f71cd42145cca0e0ce632dac60dc9d0299a6796061605cede356c26f8e1e423d05fc08ef8fe3943d21583d4aa9910c245d67e898f15',
    lookupId:
      '875266b7104ed0ac127312582449a6937087ab22e9c5fb0c7281c73937ebf312',
  },
  {
    providerId: 'PILOT-perf-124',
    accessCode: 'indexed-fixture-access-code-124',
    accessCodeHash:
      'scrypt$63dccbd782394d1c4e72c111a535ea57$b47981eb1aa936cef663bf02619d9c6d5a9a11e50a73632b76df0437a7161e6fe2cb1c484999cd8a71ba177cdff19a8de2cfbc932ed57c3cb6348f58cd7598fd',
    lookupId:
      '255a43c7279b000700038da7ee16b982917665f1e9dadf5621ef8a75ca989cd8',
  },
  {
    providerId: 'PILOT-perf-125',
    accessCode: 'indexed-fixture-access-code-125',
    accessCodeHash:
      'scrypt$6708b8cc7b95015adc786835a784cf50$eb642e3e17351b556bb906ea3143337068350fea50548f9e0265c6f262555cac95a1e42e62d58cffb8b0fad02e3420e29b60526648e1a6b63f5161827fd58e4b',
    lookupId:
      '9ff7ea072a544691d04d139e8c808bda60b79f0137920306366b586c2c292152',
  },
  {
    providerId: 'PILOT-perf-126',
    accessCode: 'indexed-fixture-access-code-126',
    accessCodeHash:
      'scrypt$b1a101ed3cb75a435462800760d93c65$7106fe590f7162e1ac274868e04fe69c09660a28bd7247243070a138a6b23b43bdbafc25df848b86d11da7bc40d39e7a410a2142212f64448266071dc445003f',
    lookupId:
      '2299fbf10e4059d439929288a2bb096b22f6a462b252ffa77c81a223927a07c4',
  },
  {
    providerId: 'PILOT-perf-127',
    accessCode: 'indexed-fixture-access-code-127',
    accessCodeHash:
      'scrypt$5efa1b91d14e57c23339c395ef9f4635$bb765d4f5d3773f5d624773b4ec92baf81b51d9a7ab23ccbbffbcc9090000c051dedbd3b27a50060d5ab1f14deea8c462e1fc712dac08370e48ff61316319297',
    lookupId:
      '6c6d6ab2e52a884cd3d5064a46e15760b9e32bc99bb6905af8fe976dbba0fa05',
  },
  {
    providerId: 'PILOT-perf-128',
    accessCode: 'indexed-fixture-access-code-128',
    accessCodeHash:
      'scrypt$cb2bc4e76d4628a57c232fbc36004246$bfd4d90a2b6257f53555a2f2ca17475fb82f9c1900f1a312c0ecbad71bc790e2389815a5142f321f6c614619c3a1a1dfc51790f559b715ccb5683deb2c23e030',
    lookupId:
      '1b01a1e8f1140155cc0016c7d00b96afc4a057e3981463b6a65e9299aca1191c',
  },
  {
    providerId: 'PILOT-perf-129',
    accessCode: 'indexed-fixture-access-code-129',
    accessCodeHash:
      'scrypt$e381562e1c03bb2f47fd97eb289d73eb$d82932f641f936069c7ba629dc944f3979268ee7493d798108ea24033afd875062847dccd451256016d8954df39070ed10867c375a890bb586640e65a3e045bd',
    lookupId:
      'b19e577b905518477e366794b0a1281e40041501570a889741c5cb819292d70e',
  },
  {
    providerId: 'PILOT-perf-130',
    accessCode: 'indexed-fixture-access-code-130',
    accessCodeHash:
      'scrypt$533ce4bc1ce539818505bf558ef2c258$878f71e8e4b03948c1f16f8d9e6a7b91eb84b7be93220c0a6596e51d40514d4c6179412f6e47516b295075a245cd0c756bf1df1bd5a307591bb2a41152ec79b5',
    lookupId:
      '9635472f9f4a64b04915312bbfe346e5604b95cff595c9317628a640e88ff4f0',
  },
  {
    providerId: 'PILOT-perf-131',
    accessCode: 'indexed-fixture-access-code-131',
    accessCodeHash:
      'scrypt$1f53ba9aaba29f0c73f7eaad6f44530f$987421733733dad875b13d4d63f9bd05a0441ba7ba192befe82af246e8be2e262698716001163d19716880d02876f806094568e25be2a1c8684bec31b240017e',
    lookupId:
      '02c874705f0addf6a157b28207c6fa40c7875924fd408c63e9f59826074b345c',
  },
  {
    providerId: 'PILOT-perf-132',
    accessCode: 'indexed-fixture-access-code-132',
    accessCodeHash:
      'scrypt$a02af40d0a8b1e5a274e97b0a802c89e$11aed764c60fc4f0b897d58cfdfb0ed70a9dffbc92e75b330b9a5459f13695d696b264070779a44f7f63a5c4ce74752ca045e03fb416fb0feb364a580ba66303',
    lookupId:
      '07eb3c6ffb8c66ee6a9f03fc781be34132c2251152d4861cfc280fb77c8930b9',
  },
  {
    providerId: 'PILOT-perf-133',
    accessCode: 'indexed-fixture-access-code-133',
    accessCodeHash:
      'scrypt$971f191da92f3a6dcd6ed7cbf8b3bb7e$8067785d33c34b5421d155f089d93b87466777e17b11dcc84d00cbc34f288c01710122b4ce30c54c671ea186f3ef4ec03307616e9ffbaa516a393cfedc924698',
    lookupId:
      '1c25fd8f7ed69d348374c30f90f207de7f9cfa24e9e8e903c18f19255c3c32c5',
  },
  {
    providerId: 'PILOT-perf-134',
    accessCode: 'indexed-fixture-access-code-134',
    accessCodeHash:
      'scrypt$5abd5456da545da60a548c5a51f1d78d$faae9eb312f8542a98a32a5a8244bc9d0f43258ca96fbc2c90e04bcd34185083f4365442369787048429f501c65bf560054725574a1a86f58802aa3d63271ed5',
    lookupId:
      '78f7838db652f5c06b0bd19b697fd2aa6d7061dd8a2bc487f8134c6521ab8afb',
  },
  {
    providerId: 'PILOT-perf-135',
    accessCode: 'indexed-fixture-access-code-135',
    accessCodeHash:
      'scrypt$d9b7f1fa0401b22e4483589da6e04ab4$883a09eb3a0936a29f5ecab3c8a20381dd86cc46548464ed34759fbd4ea0705740519ff35a08481c93402d9d6575e8cfead0e12e33badeca4228a68e94aa848c',
    lookupId:
      'c9de3cf012be409ee81f23abaff12d76307d3957e190530f01915ad3a8dd3602',
  },
  {
    providerId: 'PILOT-perf-136',
    accessCode: 'indexed-fixture-access-code-136',
    accessCodeHash:
      'scrypt$e164fb49e4d4656774a15fb4c298601a$eb222e7622fb6f9d3b1e32396316d02956d934bff210884d7b6e9c6db230d90f94fb8b5b2895e012ff22fd8aaf023cb37fbb9a1aa5f9c84791d27be46e53a73d',
    lookupId:
      '52203157bcb99c71f90167c7dd1a81615e0ce087987bcae58a84c124a93cf072',
  },
  {
    providerId: 'PILOT-perf-137',
    accessCode: 'indexed-fixture-access-code-137',
    accessCodeHash:
      'scrypt$fdde26ebe20bcf91149f56a6e1abb3ec$381002812f6a6c7e3f486fdf0a7909cb048d1c2164e3a73637dfa768ed6e83da68c39a9574ffe351df4d8d4623d0ddd880a68b373ec895f4f7e9be745775e109',
    lookupId:
      '347ee27d5cb1fe9de26bc64e4cb2ff37552ab7a7a4331a41eeec159987d47214',
  },
  {
    providerId: 'PILOT-perf-138',
    accessCode: 'indexed-fixture-access-code-138',
    accessCodeHash:
      'scrypt$283997406fcedbcbd30f6e4d29e9c2cd$d53ead99ae94872f7dbbf55aa6a20dec1c519a6efd7eb62a7441b3576c25ac151becbe123b052f7b35b7ab0df3e8898ad8634fa2c572f787820875c76bd0e885',
    lookupId:
      '00d8babefdd59c08c8511604763f0144c08bac682ac4aa310d349f7910cbb51b',
  },
  {
    providerId: 'PILOT-perf-139',
    accessCode: 'indexed-fixture-access-code-139',
    accessCodeHash:
      'scrypt$44796de348a6e91220fdc7e5d47b92fa$5e48f6a31303a352853654f0742f87014b3fce250995c4cd28e2da0778a11c7fd4bd127d902f789c0d7256d39b71049c2607d3b59952343b52e7226d2d2cfc13',
    lookupId:
      'bc38e8dec4a848f79de4613d6294542a19d710372adc93d470a77ad86199a83c',
  },
  {
    providerId: 'PILOT-perf-140',
    accessCode: 'indexed-fixture-access-code-140',
    accessCodeHash:
      'scrypt$5765439fac84871a1303d868f9122290$173f8425ca965184f555f40b22f0653980c2ef29cb433dac676063860e589cdbb66577eb7c613bafb5d74e5aab4299c2c27ee97303005274c578283f52b1fff8',
    lookupId:
      '1e5d71bfee5131de6383c796bf3acd4ce30a5b858d7288595a67bf398d9979ef',
  },
  {
    providerId: 'PILOT-perf-141',
    accessCode: 'indexed-fixture-access-code-141',
    accessCodeHash:
      'scrypt$b943df53c14064bc39cca20e59dcf413$539c49f25b19821b2ad8ed5aab933bdce30b4459f3c41cbb234a69d869db2c615f87e6449e5098c6aa6ed983984711e473be1d15d28b89b12a3d8b915e6d85c8',
    lookupId:
      '12444e3acf27614443ff732290bf500680fcc674d37d11710b15d4efae6db54e',
  },
  {
    providerId: 'PILOT-perf-142',
    accessCode: 'indexed-fixture-access-code-142',
    accessCodeHash:
      'scrypt$c5b3f08404d9acbfe7f355fd6e6a0e24$349159f49dbb6a8950695b111ed70fa57bdb9a8206805c8eb7b2e7924288e8cb2b2e0b65877ddf2911e106bced47ea441c4728e9429d8866f735755eb80fcd89',
    lookupId:
      'e1e598639e6d97d73ec1d8a93625f5397c8beff453bf2db3e5684ec4c9654582',
  },
  {
    providerId: 'PILOT-perf-143',
    accessCode: 'indexed-fixture-access-code-143',
    accessCodeHash:
      'scrypt$9357c172a645f2751592419578ccf5a3$593a72b7e9107b8f1bd2b755b8f0d0230abf285a95cde1378256f69ac04d97cd3c3dc1f5cc7385709f85d07f13b14ccb3c27c1e8ecd483d9ab8244f15f4be5fa',
    lookupId:
      'c059cae9c66fc31a7310b30c056856dc6403fba707eb182899a78f2113477feb',
  },
  {
    providerId: 'PILOT-perf-144',
    accessCode: 'indexed-fixture-access-code-144',
    accessCodeHash:
      'scrypt$1671240d450db078ff04a338b43d59c2$9eca16b9c0b47f70a51989d3c80704c546774b502d264bcf6d9444c24df8cf7e06a7de40f22ca27276f52e0d36ec43b6775fe86b5eb2e94e9d501af1b8f65dba',
    lookupId:
      '65a197e10afaaf5be4e1b62816d7f110330904fa71fe469fefd26a85fd4102e8',
  },
  {
    providerId: 'PILOT-perf-145',
    accessCode: 'indexed-fixture-access-code-145',
    accessCodeHash:
      'scrypt$3a624df75660c224d1d0cccfceb6190c$7292eb76aab519f7dc399b9d941ee391094d33e56113dda05b21cef8ad8cb3c8cde8cad1ae1b7ea8d1298afb088ce8cfac99875b092e31134ae2ac42e4292e0f',
    lookupId:
      'a99e3b6d667ae2a9fda690b9da0ad31bfb4d306a5aa13880894f1ce17e94a36d',
  },
  {
    providerId: 'PILOT-perf-146',
    accessCode: 'indexed-fixture-access-code-146',
    accessCodeHash:
      'scrypt$13859e11dc55ef3d75c3304eaaa5290c$d614565e3f2fbb668e15dbfe4bca63610e4c925733103abbbbcd480e3156ef84b4966e82bc5d0823de3043ad4b271ad28516ee16400621f9a74dd1300f190513',
    lookupId:
      '102d96bf5b8d0f2c75929742b0b62b0415f5b60ac777b6b3ac761997b8165ee1',
  },
  {
    providerId: 'PILOT-perf-147',
    accessCode: 'indexed-fixture-access-code-147',
    accessCodeHash:
      'scrypt$ec4f410909b1b31389f63679840463ab$d7d7004ff273084a66479be7d889641e19b5ac44e546ad307b7c2f3feb84b5659e5981bf869ff621b56e4f976421f07672927ac14daddc71b5e7c4e6dd5b0d5e',
    lookupId:
      '53a8957c3579f898b659dbc94d1a06aaa4f1aaf8135d12ade2a2dbb32ac9b8a8',
  },
  {
    providerId: 'PILOT-perf-148',
    accessCode: 'indexed-fixture-access-code-148',
    accessCodeHash:
      'scrypt$6352f87562e8ff758b039263c7a5aa9f$1a4c2498b76502ef8c026c89a9f1c47dc1c132c4dc0f03981170a0d48669f103a995a1645cb169082139babd05034b945db253652129f4795d00f608a464e365',
    lookupId:
      '4ed92a322a97f799c23fec3347aad8aeb079d0aa2b738b32eba67b8f58306cae',
  },
  {
    providerId: 'PILOT-perf-149',
    accessCode: 'indexed-fixture-access-code-149',
    accessCodeHash:
      'scrypt$805b7623fbfb8e931e4ee93523a8b731$837355646ffa45b5f5f7a497dfd43919adac2d8b8245299e74010c116ecef7eb601ced292ff142e9168d7c9c323dc57dacbd134200e10e92849f5cdfd8699537',
    lookupId:
      'b2aefe2798ae6731512c5670d4aa37034724db0dff8c14c4ad0464e5b930dd47',
  },
  {
    providerId: 'PILOT-perf-150',
    accessCode: 'indexed-fixture-access-code-150',
    accessCodeHash:
      'scrypt$03325cd8d7637b16f9491f23f224333c$1cdb4cf6d711e528e180fac4b8aaec159523fbd20a34a84a5af07b945e8fa63246d1a93192730ca6f3801606203d7f7abc21df2e56ac0cc516a06943443d19ef',
    lookupId:
      'fa947338107af1a7f78c8f84def8e65db567696b3047240402711cff59cdeed4',
  },
  {
    providerId: 'PILOT-perf-151',
    accessCode: 'indexed-fixture-access-code-151',
    accessCodeHash:
      'scrypt$a30f0111adad74e292559e015d2413f5$0f092ee7e477dc679d6f7d999b421f139fd8980eb87b4e16cd114478183bdfa3c42cfb14d4d3f4e883562ad5fad95d06e1a13094d752805e6be20a23d0050bdc',
    lookupId:
      '563183bfda868f290e8c3743c0f45625804a18100d0c2bafe506b9c47266c280',
  },
  {
    providerId: 'PILOT-perf-152',
    accessCode: 'indexed-fixture-access-code-152',
    accessCodeHash:
      'scrypt$53e3249fda68f404de5a2760583e306d$223a7e654dc1b28ee6fba515ee72062eeda52db28984839d3691f4170a89fe32effcba997bdef724bfd823b85b741e6580b2c985cc73b2b68b8551eda4b6b03b',
    lookupId:
      'bc6a79d52dfea2ec6a02b0689eb2bc6dfc5ca93d7d83366375c8454d845fda47',
  },
  {
    providerId: 'PILOT-perf-153',
    accessCode: 'indexed-fixture-access-code-153',
    accessCodeHash:
      'scrypt$06d02d72519c0fac6c3d5f1622e55722$363136042f55f84c276ff46c848aec186b3b676dac0605f7cc10fcdabf1cd36a00b10f8879a827200cf364870f21160327158bea82206da998f672b1ee60550f',
    lookupId:
      '0f9940b427e9853fd77e1ed04f7ff74c60f3ad78ae85e50feac0358ded9aee90',
  },
  {
    providerId: 'PILOT-perf-154',
    accessCode: 'indexed-fixture-access-code-154',
    accessCodeHash:
      'scrypt$7f7a9bc3891a64181c89cf36f0adcc9d$02d08cc925557ad1509c6378d87c4056c4c4c9215b0a15e41a1a13bfa356f7186a0bed841c6b749d762385c3cf6b81ff88f1b12e97269b1253e3fc46c75b210b',
    lookupId:
      '2a1e48e039a7cc8fc1eb1cc47666a4c49dd7baeb28a38076195cbbbb4c0a990b',
  },
  {
    providerId: 'PILOT-perf-155',
    accessCode: 'indexed-fixture-access-code-155',
    accessCodeHash:
      'scrypt$11b277b4ef93bc9657862078b5a21d03$57f3b623b0e8e72eeecbb81c0eef499d6d7f19e39015dce9f0081dfc1b298cdcb31a28678f78bfaa54722b69752d7833ce1079220626d6b891c065241c5bf23f',
    lookupId:
      '253c6d243291202348e7df00a968e889771dcafd54a32742e47fbdfa0eb8d31d',
  },
  {
    providerId: 'PILOT-perf-156',
    accessCode: 'indexed-fixture-access-code-156',
    accessCodeHash:
      'scrypt$c27127355b568a888777b7c5a484ce39$93d2d970dfc4e08221cd6f4914ccb37d65a4bb50ad743d3e442ceab1c1cb41d1f4c2103a5d1d8c983abb7481da895fde728d87d46f2b530f8d8137491aa18b2f',
    lookupId:
      '5e2403908b1ebf88d7bbce35b8eff787452b606adc4fc7ee426ade5cbb2753c3',
  },
  {
    providerId: 'PILOT-perf-157',
    accessCode: 'indexed-fixture-access-code-157',
    accessCodeHash:
      'scrypt$2c279935dba2013716d24cead6b8d44c$2be452bcea91108c38283aa8a034fea35762d0621e16a760a4de557e6c53b2c69492419e7ddea1fe2e963568e05b29d37e7fee037abd0438053f2d6702a9bd22',
    lookupId:
      '5aedd74ab16c6184bbca1737104be8960ec9f2171bb9794e52295e94fa479519',
  },
  {
    providerId: 'PILOT-perf-158',
    accessCode: 'indexed-fixture-access-code-158',
    accessCodeHash:
      'scrypt$336765651c74172be2cfb5826a1656a2$d67bedf23d86737f8309136e68c87bb9abfc5b8e7077770d85ca8690e7f409b46c34e43eb94c0736bb6cd1ba284be31e858d384171fd42cc1ee9912f3ec55560',
    lookupId:
      'b3cd115e808ad65ce45d314486ecacb2403cb9dbca8f9b949fc03d80a37b9cb5',
  },
  {
    providerId: 'PILOT-perf-159',
    accessCode: 'indexed-fixture-access-code-159',
    accessCodeHash:
      'scrypt$5bb009c8082444e1c31de6fac2d72252$c9d0421e04b09d41a5f7d6972260e78c59cf2271756833848d97b31adcf7c64b7d5cfd6fe5c4fdd06914ab1adbc6446d7057a02ee11a27a4838118bc899a0f93',
    lookupId:
      'fce135bcb7fdb5e902487296d17e04e1b43cc73e6663031a3c0d71729bb407f4',
  },
  {
    providerId: 'PILOT-perf-160',
    accessCode: 'indexed-fixture-access-code-160',
    accessCodeHash:
      'scrypt$80ef32127b62b2cea3ac862a5802c669$1a52f474c3818874a66af0ad7aa5a055df62cfd6a3c69c2c6851c0b9ab541c589231bc057f53c2f9b7abc97c8b94faddf834841dea205bdd03ff3b94ee517528',
    lookupId:
      '3abca7ee726bcc52e9267cba42cd8bb311e9a51887293a4c028b2b88ea54db0d',
  },
  {
    providerId: 'PILOT-perf-161',
    accessCode: 'indexed-fixture-access-code-161',
    accessCodeHash:
      'scrypt$d005ced27da12d1c0bce3d07eee154f0$ffd5191086984bd58e89a5119ff6b4a5b44a75a1ce2b93ffce04631fa8c41747e727c7e5eeb9090aa5b9a372ad21037c24d8d17b0584b9cd566ac85942a26b8a',
    lookupId:
      '23d9c3dc2d8f5b5108417054071532cb6e2d10c19acd1261e97289a3353da268',
  },
  {
    providerId: 'PILOT-perf-162',
    accessCode: 'indexed-fixture-access-code-162',
    accessCodeHash:
      'scrypt$0c23266c5da7c752879fd89946f344c3$7357a1e7f38d9d34ad3067ccded1691adbd0cd40836968e6f14c63a369df4f6c45ebb24e245f1df0b89983d7895827c629e6ced423f8f82c2a99fa3dc01e5361',
    lookupId:
      '4153674e8af938916cbe472691526cba34046bd32e2b6c114f38ac5a05783499',
  },
  {
    providerId: 'PILOT-perf-163',
    accessCode: 'indexed-fixture-access-code-163',
    accessCodeHash:
      'scrypt$9f18129f44e00c6696d42814f5b94937$6d23447239ca25fede6eb66288bc664dcad28930729bd7759fc8216421508b851e4a5d09d3f6900755e33767931cb00a99d81417e4cb05f79e5600c0af585931',
    lookupId:
      'e86160088c44518fad731f688fc7bc9b64686bac3d5aab8786bb8d7ba6a595cc',
  },
  {
    providerId: 'PILOT-perf-164',
    accessCode: 'indexed-fixture-access-code-164',
    accessCodeHash:
      'scrypt$92ac01d401de7f1194a60799d2fe849f$f3577f1630037de77258d24850327154dca973a83fea6ee35c28bfb9af1ace8b3b18e3789e0190637922ff2f5b6358a0417193582817a8a340e9261a568e8039',
    lookupId:
      '8678115d2d558aadcce5077b8cde35b48a49430dcab18b052978efc62a20ba7a',
  },
  {
    providerId: 'PILOT-perf-165',
    accessCode: 'indexed-fixture-access-code-165',
    accessCodeHash:
      'scrypt$470ff8611135864237acabf9398d3165$7ff2448d576b1f6191f57af4afff0f78d5a1319aff6f37ba1c06e0c3b4a8fdc8b0ec288f1e917afdd31a49130fcb164d44bac107ba5eda2e70639e547d340cfc',
    lookupId:
      'b42dd5922453cadc384bbc5fd60fabdb128240bf7a3a7b3b5f568484fb87fcab',
  },
  {
    providerId: 'PILOT-perf-166',
    accessCode: 'indexed-fixture-access-code-166',
    accessCodeHash:
      'scrypt$9680d4df8cfc185d7937818d37c08cee$ce08786a6adfe5993450779f8f7056658dd2fd486cf67af075a01adadb7475f00d45906472918cdd5ac963c8d12848a2350095a1b25f58d224fd97f77a4c8265',
    lookupId:
      '89267620deb2abd86452237d440711f2edc9760e53e6353296a9cb506ff177e5',
  },
  {
    providerId: 'PILOT-perf-167',
    accessCode: 'indexed-fixture-access-code-167',
    accessCodeHash:
      'scrypt$b7c4726064929e905ee4694133457e58$1266e48f6e276b0520c4c0c0aa0c3a9823a8f61eef8da4f2378f99e6c24ae663fdb886bf72b73ef49d72d7782b9ac438635123defa94c7fcab6db7966cb3b02e',
    lookupId:
      'eebe4e46dd0e01493b46b6bcd989d4cf9351fcc3561275ed20453a21526e66d8',
  },
  {
    providerId: 'PILOT-perf-168',
    accessCode: 'indexed-fixture-access-code-168',
    accessCodeHash:
      'scrypt$113bef3744554f7070accbe7bf54d183$f0ed59f159e8e03c3c268f8abc910b5227ae9753666227b56cb1b253f2c48cdbda67fbbf31581ca6dea8cf0b188f718dbf3b351351a2a67250172f82d770ea26',
    lookupId:
      'e34d82aa9c0d69d60222e94e35224bd8c280301f0ad7a8dcce9c9a7bdab9328b',
  },
  {
    providerId: 'PILOT-perf-169',
    accessCode: 'indexed-fixture-access-code-169',
    accessCodeHash:
      'scrypt$7553a8001b362da9338a9cd8c0bb6964$db38bdcb8ad5b8dfdc05c85d3488b2f6f90a6eff40811446a9f9d4a250752f83c774d6a461f5f189790f519e32e6a47976599e651f03121f8ce6e8cda368d057',
    lookupId:
      '8354f9f64dc3f08dc06f6516ee615b2ba2f7614cd9d933aa6dc83e904d35bdbb',
  },
  {
    providerId: 'PILOT-perf-170',
    accessCode: 'indexed-fixture-access-code-170',
    accessCodeHash:
      'scrypt$4ae87f4ea7a3239ed9175641d56eb479$d6f0d58eebd23688e60377e409f11a08491cd0b2fd296c2507fd05ff89c5454bef0b849775182f706183c9b2be8b6176fc846e2692bc2a9b68743653aa8d95c9',
    lookupId:
      'b117a52e2d57cd4c3383a26b3a3c68411d3b2f4827dda137536d93f97ea29c0d',
  },
  {
    providerId: 'PILOT-perf-171',
    accessCode: 'indexed-fixture-access-code-171',
    accessCodeHash:
      'scrypt$88bc6cd9502100f5dd4fefa573a32546$f6a75fe298ab138daa402a4617ac77442ef78c4c00f6b1988ccf4dc2f065af6fec28f98cb41bc6d20e8e47972e7afefc4e44d0e8829ee564de1b6d1801c296e1',
    lookupId:
      '8ce41faee63fbb3206fa1dbf4921dff21006be44d5b1526699eb0f35e96e6b06',
  },
  {
    providerId: 'PILOT-perf-172',
    accessCode: 'indexed-fixture-access-code-172',
    accessCodeHash:
      'scrypt$56d358f6977fd71a7c000967bdc3256c$46f31dd254a1ecb17b6bd64c08318e6f150069f2b5a624211794b154ce23493e72848de2cec4eb1efde8a4e97334f2c9a72d8d1544f516d77db585ba9502f883',
    lookupId:
      'f51ec6e3d0abeb73f603c9dfeb931153f7ba25ca610edef037d35ae579d1dd15',
  },
  {
    providerId: 'PILOT-perf-173',
    accessCode: 'indexed-fixture-access-code-173',
    accessCodeHash:
      'scrypt$5f50cd5400cc411c61a26a8a38140408$1c0006ac3850af15e82c2dc62e4755e15c564d79118a43765a4d13177d7c6fb3ffa0c17f0274ae61d02ae9183bd378e503d49d6e7f86f29c3487c2d1470be495',
    lookupId:
      '096d9c09407e0b77e88ed61adeb83ddce563d90f8332240c6763a3d0ce5e5566',
  },
  {
    providerId: 'PILOT-perf-174',
    accessCode: 'indexed-fixture-access-code-174',
    accessCodeHash:
      'scrypt$c73a90b8a0192d87cc40f77c9e47d61f$4080d61ccad48ed56298ac9c9bb7494900d597991c3434338c7a9d3ec2bb618e6492194b3b70f93b9c2283c0a0a498df91304bf6cfa8abf1cc375503752c45ab',
    lookupId:
      'e57e49fb6c4c38a6f9dee5a2f2c2dcd761c247c8c66da1d78e29084c0fa68642',
  },
  {
    providerId: 'PILOT-perf-175',
    accessCode: 'indexed-fixture-access-code-175',
    accessCodeHash:
      'scrypt$c8ddf10e28a2f682e7627f3043ceacd0$8888e27319af7ae37ae0da7929f00e7eeb3e3dd689917f85f22e62b667705bd14f78cc7aea86b070a539a3e634dde566a4fa052911944c32f1919d66939732ea',
    lookupId:
      '32c79b78da011e1d1510f62a3edd0dbe9f43a147c875c496ac317ff3ae1b6f82',
  },
  {
    providerId: 'PILOT-perf-176',
    accessCode: 'indexed-fixture-access-code-176',
    accessCodeHash:
      'scrypt$9f3f0e9e1a69f321e57601485aad962a$71ca32085844412c8d5314b38261236a96202865f8b8ffbcde0191fc8aeaeb9126c016b187145557e859e76bfec2901ec749c665614b0b5249354f8961dcc109',
    lookupId:
      '53ef58e5becf2bfc4f8f7e137e52606b7a14cb37e20ff62fd430c95b157cf389',
  },
  {
    providerId: 'PILOT-perf-177',
    accessCode: 'indexed-fixture-access-code-177',
    accessCodeHash:
      'scrypt$2ed767755296227dcdb73524259a4245$7ae00d3887b5aff2e85e664bf9bab311d5ab65a6b7f4b6c66bd9136229e25043244282aa835ca960cee00650232cc28c4725b14f357c47fde529168e75d6d43b',
    lookupId:
      '4b513e6934129336e98083b16bb1e21195485cb55b7550b294108517da0bd2cf',
  },
  {
    providerId: 'PILOT-perf-178',
    accessCode: 'indexed-fixture-access-code-178',
    accessCodeHash:
      'scrypt$ab0863afe6abe7def074ebef19a1111e$ab720b7ae54c350ab6f9536736ca906b8fdda1514e92e996d487a513d933337dec9ef6d990870d0f0bb825f075f347b70cc9977ff38e4f153877b4a65746cf02',
    lookupId:
      'f3ed3e86a2fd6c9a6c461d033a1fb66810deb8b85b6f607a3f0b6886aece4928',
  },
  {
    providerId: 'PILOT-perf-179',
    accessCode: 'indexed-fixture-access-code-179',
    accessCodeHash:
      'scrypt$02d66d573f096a937e453f6cb0708399$410a8f191e441e5372623526c5a4c4611cfa80ab126c1ae975663ecc09cd49b9734606a3420b9af13ac455c51aa2742731f7cb15d97ebbc070b5cb5b26a323ca',
    lookupId:
      '3808b6b99b2972c5eaab57ce3dc9c30c4f5e51b37485c9a8d05bbc9be124e2d9',
  },
  {
    providerId: 'PILOT-perf-180',
    accessCode: 'indexed-fixture-access-code-180',
    accessCodeHash:
      'scrypt$f30466203340cb67fd794460e08ea898$dad61f7786e85899581322829df541914c094d3466f2211c0d849fc3913bb4d8b6adc59bc3385849dfaef4f8e5dea2c0a66e953301d0afbc099883c29eff37e5',
    lookupId:
      '12c3cbcdf973a5a8fd969e016adb8ab8a346fd914a5c3e7498b2d9e9988ec3c3',
  },
  {
    providerId: 'PILOT-perf-181',
    accessCode: 'indexed-fixture-access-code-181',
    accessCodeHash:
      'scrypt$e9ea75e7d5fb308177cdc2fa52cc3d6b$79d482f4a32d232fcc1e070356618cc6f0afd4675103f5afe11a22979cb658abb9751b272e67becfdab00a45cde50f215b226aa840ac798dbf27757178d6b1cb',
    lookupId:
      '32d7447f25324b3fe3635df84460efa7009edbb3975f3617e2681a36376cf5fc',
  },
  {
    providerId: 'PILOT-perf-182',
    accessCode: 'indexed-fixture-access-code-182',
    accessCodeHash:
      'scrypt$6144c8c92e0844cee5336fb49d50ae29$ae1ada3ceecaa58fd0ce6a6ce2971ee02c52e18da3da850da3780073c481d2b2c55241e7fe74b25b1b088fe18af988e57aa306f2c7b966306ff71249ead40fbb',
    lookupId:
      'a7ba2a0473c3682e368e4bfc45bb70b0533c784bcb628deb3630864187f3b832',
  },
  {
    providerId: 'PILOT-perf-183',
    accessCode: 'indexed-fixture-access-code-183',
    accessCodeHash:
      'scrypt$3d473c07dc3093e1134895e2cfe26b99$9f1f78774a0bfbdd0159eb0fe2e611fca164727f5ad36e9e77efd1900a4e93bd5aeaddb2f285cd22ccc0d434efcf8be5ae3c5574805790659ee7a8bf600f3ec0',
    lookupId:
      'c0fb62471ef461b7bac6344e473f57946295af60e40aea58058aca3fb543f696',
  },
  {
    providerId: 'PILOT-perf-184',
    accessCode: 'indexed-fixture-access-code-184',
    accessCodeHash:
      'scrypt$523c91942bb0a0ec7653a867fbdbe917$de269c9c0d0e9feeb4e8271c22020c553260f779bb550acd55630ca2c144397a52621738519b0eec1d699469014c6350a759d334b7d31788a3d4cf2d85f4e1f6',
    lookupId:
      'a2d297ee5766d03c380280132712562c303b235aa99eff68dcd9c1d61682f225',
  },
  {
    providerId: 'PILOT-perf-185',
    accessCode: 'indexed-fixture-access-code-185',
    accessCodeHash:
      'scrypt$daf432defbd6668303917af999411159$a479d24a46b061db82f38159122c90448e8a88fb0ad3fcf084c43e35405e36f928e57fae3bfdc18f3357b9c8e89abbdae3efbd51670a0d6143fd4670c3cab9a3',
    lookupId:
      '730b4fccd362bb3b94a4773ae43fc060194ed9a9d46f930adf0d276b8a118505',
  },
  {
    providerId: 'PILOT-perf-186',
    accessCode: 'indexed-fixture-access-code-186',
    accessCodeHash:
      'scrypt$026c3e1eafbcdf4bda6d5fa1958ef76c$01bd88a5ed53cc29888cc67f6a179d7c0d8c676f1a4601107553f91016beb1f673c88e7bcf376ce465b2150f81df845ae083c121e73c2fd73c529e5fe8ce8d4b',
    lookupId:
      '3e2afba685e32c49fa788a64d2aeb12f367e254d179bd4acb12f879592b850b1',
  },
  {
    providerId: 'PILOT-perf-187',
    accessCode: 'indexed-fixture-access-code-187',
    accessCodeHash:
      'scrypt$18e4e56bff2428e0d15c5094fd2da24c$9d0fc0f6162b72d89b670d045ded76d0b7b4bc0bc6af2637d902ec29a30442065940d3ede860d1eca2ac25f2a79dbdb6948274f31ca99f0571776610fe125247',
    lookupId:
      'd83752ddb669220b4b88a29365bd71607bd0ad9c5e22a7421596abc387e4fae3',
  },
  {
    providerId: 'PILOT-perf-188',
    accessCode: 'indexed-fixture-access-code-188',
    accessCodeHash:
      'scrypt$920cf3a3cf3b4710da05b442c8efb11d$cdb3050e5dd1f75c40aaa342a6b7fd092b165b8b687cffe69382b0b253f3f81387011ea01e9767ebe90064db89794d40ca91a0a64c717bdc404dde8925d6b473',
    lookupId:
      '8c4acd088fe9a5ffabe6d53675617ff617739efccb328fa591d4a27c21bdc05d',
  },
  {
    providerId: 'PILOT-perf-189',
    accessCode: 'indexed-fixture-access-code-189',
    accessCodeHash:
      'scrypt$9531177df1b23ac67c7a2c8849a5bb89$43c7a04acac5182db4b7c17589d7cc8e26ae2fcd860e9e4468a181d06fba877e061040066f492d8ad4f586e7ea050a9c199477883c9bae0f4f87859648ff3776',
    lookupId:
      'e104b1cd732072bf55b7b4b647f305b1f9642e7be0c150bc4923f2d0107b401c',
  },
  {
    providerId: 'PILOT-perf-190',
    accessCode: 'indexed-fixture-access-code-190',
    accessCodeHash:
      'scrypt$c62f88c9cfd1def5cbda3e7f560496dd$0f6d9b28d991157c14883ee29d141aa3aba467fd7f25c46f9d884c660c1e161d9ea98ffe2f8a899230c6371d222997c5bb0923a699a7fd267178fa742cfb48e0',
    lookupId:
      'e9c4eee4bf2c3d66b458d0aa24910b0917f34298ff8eaaaf6633e3d595c6fa65',
  },
  {
    providerId: 'PILOT-perf-191',
    accessCode: 'indexed-fixture-access-code-191',
    accessCodeHash:
      'scrypt$1293297e7ccf37754c99ad30b68f3529$05624a0b922bd50d3f654c2656ecc0c5ecb09ddb160bbd281ebd298cb922257c9dc37961c5b531f346cf57753585fa352d800c0d86c26d497a03b62d9bd487a0',
    lookupId:
      '2a72cc4edf3363151643272809d779b5be5741839e7749b534b61f451376fa96',
  },
  {
    providerId: 'PILOT-perf-192',
    accessCode: 'indexed-fixture-access-code-192',
    accessCodeHash:
      'scrypt$cdfae1f6947ff2759ec45d94b5f8a8ed$fb0eeee0df6786dd382c75b9ae5abfe785ae46f9e691e5f66eb1e9f379f9b6d2c9f5e038531fcdb2205f0bb0ab812769094723a3918e3e240c4d7b5c1c9b338f',
    lookupId:
      '30532093d2f732935fa6a2a3734ce84284d242b67f4ffc0a491d682669ebc727',
  },
  {
    providerId: 'PILOT-perf-193',
    accessCode: 'indexed-fixture-access-code-193',
    accessCodeHash:
      'scrypt$b3898978a6ea0d157cc0dc4230364e9b$732db7c2681ba972b1c93887baaa069343d48db43d637761174cf21f092bc98da0856cfce5b903ff269a4592fb0764dce9fbfe8060ef438b99e228a83918ee76',
    lookupId:
      '70d91cea90f46541fbc2edf649e5a96e5df828f7309c4698e8a14683e9a6b63c',
  },
  {
    providerId: 'PILOT-perf-194',
    accessCode: 'indexed-fixture-access-code-194',
    accessCodeHash:
      'scrypt$ae91696370824f1be21ec699f01ad093$13ff99991a05bc2e76c50e0b79995777c7b4d7717ef70e27122a509002fa64bed9a4a2ce39261c95f07dfbd7e4df226f3d828c8242f29b0bd3f57bef53bda595',
    lookupId:
      '6f694f1ceaff28f33b3b6ef5346ac6f5a09ec113871af3286e5872dfcc05c2d8',
  },
  {
    providerId: 'PILOT-perf-195',
    accessCode: 'indexed-fixture-access-code-195',
    accessCodeHash:
      'scrypt$beff0c16d14f6588f2e8bd47261a35b9$b7d71108a7df86f09795c1b65f6d8d7b7aa6168b5166fdf8b000167aa057166ed094ca9e43a2fc73ee254a4482b00c43dcbe37e6b0d99d529e67522dc2f43937',
    lookupId:
      'e09e5150e8a02e5556e6d5915aff6f598ab314c458b9f908a835cd602e84ba0c',
  },
  {
    providerId: 'PILOT-perf-196',
    accessCode: 'indexed-fixture-access-code-196',
    accessCodeHash:
      'scrypt$de3becb4f56ddf991dfe487a75879fc7$b3d115b827468c76e48cc74504b3706d037d77f08faae1682af761d3e444d2443e73ef764449d79fd13ac9e5b1f6ae9f7ce4f4841f8d3ca017a8e78b0730ce6f',
    lookupId:
      '2424128833cf95377cfa676767dda8d28d95cc71aafa6a4b25cada1e17c92d11',
  },
  {
    providerId: 'PILOT-perf-197',
    accessCode: 'indexed-fixture-access-code-197',
    accessCodeHash:
      'scrypt$a5b751582ca847007830996925338851$505e5dfefc748290ba427b23ed1243ce198e0a110d9b506695569025d9c90425c0e71ea43f061f2918627b13b262eb28ce37b8e61792b7aad5170b104f4f7d3e',
    lookupId:
      '97fd5335994b2d30b6dc60a165a6a1cf7138cffe2a6c3aacbd3e6cf9065717ee',
  },
  {
    providerId: 'PILOT-perf-198',
    accessCode: 'indexed-fixture-access-code-198',
    accessCodeHash:
      'scrypt$314d93c69e758c054cd6fff756aa093e$89e1fef61c1601effebd1478d8b24bd641a0aa8bf6be4ec1bd6ad6897612b7b1305f958c0451bd222899b6e7e4e81911663cd270e23eba683fe188e66e571e93',
    lookupId:
      'f3e3572a0efdba7aa39b3e836d01bd6b280418ed7403fffba73f26adb4b78e1e',
  },
  {
    providerId: 'PILOT-perf-199',
    accessCode: 'indexed-fixture-access-code-199',
    accessCodeHash:
      'scrypt$534d6f62d6384e1d794d3d93a3941aa1$96dd7ad14f1128dc9c57ba9189e437842c61130f837b1bfa3e0655a9261c01f8b76f3eeb1c27909eeb1091002470578b3b01e5af7786363c959b5b313a5aa754',
    lookupId:
      'f3252f2586dc27775eea66cdf3c7f679084c50953f4127e24c6fca09666c67b7',
  },
] as const;

describe('ServiceRequestRepository', () => {
  it('requires a dedicated test database connection when running tests', () => {
    expect(
      resolveDatabaseConnectionString({
        NODE_ENV: 'test',
        TEST_DATABASE_URL: 'postgresql://localhost:5433/moeen_test',
      }),
    ).toBe('postgresql://localhost:5433/moeen_test');
    expect(() => resolveDatabaseConnectionString({ NODE_ENV: 'test' })).toThrow(
      'TEST_DATABASE_URL must be configured when NODE_ENV is test',
    );
  });

  const repository = new ServiceRequestRepository();
  const staffAuthRepository = new StaffAuthRepository();

  beforeAll(async () => {
    await repository.initialize();
    await staffAuthRepository.initialize();
  });

  afterAll(async () => {
    // Q0-SEC: the shared-schema LIKE 'PILOT-%' row cleanup is gone. Each test
    // run works inside its own unique schema (moeen_test_<runId>) that
    // global-teardown.ts drops with CASCADE, so no cross-run cleanup is ever
    // needed and no shared data can be touched.
    await Promise.all([repository.close(), staffAuthRepository.close()]);
  });

  it('persists login failures and clears their throttle bucket after a success', async () => {
    const attemptStore = staffAuthRepository as unknown as {
      countRecentLoginFailures: (
        scope: 'staff_login' | 'provider_login',
        subjectHash: string,
        since: Date,
      ) => Promise<number>;
      recordLoginFailure: (
        scope: 'staff_login' | 'provider_login',
        subjectHash: string,
      ) => Promise<void>;
      clearLoginFailures: (
        scope: 'staff_login' | 'provider_login',
        subjectHash: string,
      ) => Promise<void>;
    };
    const subjectHash = `test-login-subject-${randomUUID()}`;
    const scope = 'staff_login' as const;

    await attemptStore.recordLoginFailure(scope, subjectHash);
    await expect(
      attemptStore.countRecentLoginFailures(
        scope,
        subjectHash,
        new Date(Date.now() - 15 * 60_000),
      ),
    ).resolves.toBe(1);
    await attemptStore.clearLoginFailures(scope, subjectHash);
    await expect(
      attemptStore.countRecentLoginFailures(
        scope,
        subjectHash,
        new Date(Date.now() - 15 * 60_000),
      ),
    ).resolves.toBe(0);
  });

  it('atomically reserves no more than five OTP verification attempts', async () => {
    const challengeId = randomUUID();
    await repository.createOtpChallenge({
      challengeId,
      phone: '+966****0001',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const reservations = await Promise.all(
      Array.from({ length: 6 }, () =>
        repository.reserveOtpVerificationAttempt(challengeId),
      ),
    );

    expect(reservations.filter(Boolean)).toHaveLength(5);
    await expect(repository.findOtpChallenge(challengeId)).resolves.toEqual(
      expect.objectContaining({ failedAttempts: 5 }),
    );
  });

  it('returns seeded providers for dispatch', async () => {
    await expect(repository.findProviders()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'provider-1',
          name: 'فريق التبريد السريع',
          available: true,
        }),
      ]),
    );
  });

  it('resolves a customer from their opaque session token', async () => {
    const customer = await repository.upsertCustomer('+966****0112');
    await repository.createCustomerSession(
      customer.id,
      'session-token-for-test',
    );

    await expect(
      repository.findCustomerBySession('session-token-for-test'),
    ).resolves.toEqual(customer);
    await expect(
      repository.findCustomerBySession('unknown-token'),
    ).resolves.toBeUndefined();
  });

  it('keeps the OTP resend cooldown after the API repository is recreated', async () => {
    const phone = `otp-test-${randomUUID()}`;
    const requestedAt = new Date();

    await expect(
      repository.reserveOtpRequest(phone, requestedAt),
    ).resolves.toBe('accepted');

    const restartedRepository = new ServiceRequestRepository();
    await restartedRepository.initialize();
    try {
      await expect(
        restartedRepository.reserveOtpRequest(
          phone,
          new Date(requestedAt.getTime() + 59_000),
        ),
      ).resolves.toBe('cooldown');
    } finally {
      await restartedRepository.close();
    }
  });

  it('persists OTP failure attempts', async () => {
    const challengeId = randomUUID();
    await repository.createOtpChallenge({
      challengeId,
      phone: '+966****3457',
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });

    await expect(repository.recordOtpFailure(challengeId)).resolves.toBe(1);
    await expect(repository.recordOtpFailure(challengeId)).resolves.toBe(2);
  });

  it('consumes an approved OTP challenge only once', async () => {
    const challengeId = randomUUID();
    await repository.createOtpChallenge({
      challengeId,
      phone: '+966****3458',
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });

    await expect(repository.consumeOtpChallenge(challengeId)).resolves.toBe(
      true,
    );
    await expect(repository.consumeOtpChallenge(challengeId)).resolves.toBe(
      false,
    );
  });

  it('persists an OTP challenge so a restarted API instance can recover it', async () => {
    const challengeId = randomUUID();
    const phone = '+966****3456';
    const expiresAt = new Date(Date.now() + 10 * 60_000);

    await repository.createOtpChallenge({ challengeId, phone, expiresAt });

    const restartedRepository = new ServiceRequestRepository();
    await restartedRepository.initialize();
    try {
      await expect(
        restartedRepository.findOtpChallenge(challengeId),
      ).resolves.toMatchObject({
        challengeId,
        phone,
        failedAttempts: 0,
      });
    } finally {
      await restartedRepository.close();
    }
  });

  it('blocks an unverified pilot provider from dispatch until an admin verifies it', async () => {
    const customer = await repository.upsertCustomer('+966****3459');
    const request = await repository.create(
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    const provider = await repository.createPilotProvider({
      name: 'مزود اختبار بريدة',
      specialties: ['ac-cleaning'],
      serviceZone: 'حي الصفراء، بريدة',
    });

    expect(provider).toMatchObject({
      verificationStatus: 'pending',
      available: false,
      serviceZone: 'حي الصفراء، بريدة',
    });
    await expect(
      repository.assignProvider(request.id, provider.id),
    ).rejects.toThrow('Request or available provider not found');

    await expect(
      repository.updatePilotProviderVerification(provider.id, 'verified'),
    ).resolves.toMatchObject({
      verificationStatus: 'verified',
      available: true,
    });
    const assigned = await repository.assignProvider(request.id, provider.id);
    expect(assigned.status).toBe('assigned');
    expect(assigned.assignedProvider?.id).toBe(provider.id);
  });

  it('blocks an approved pilot provider from an incompatible service category', async () => {
    const customer = await repository.upsertCustomer('+966****3458');
    const request = await repository.create(
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    const provider = await repository.createPilotProvider({
      name: 'فني سباكة اختبار',
      specialties: ['plumbing'],
      serviceZone: 'حي الصفراء، بريدة',
    });
    await repository.updatePilotProviderVerification(provider.id, 'verified');

    await expect(
      repository.assignProvider(request.id, provider.id),
    ).rejects.toThrow('Request or available provider not found');
  });

  it('creates an opaque provider session and scopes jobs and status changes to that provider', async () => {
    const providerStore = repository as unknown as {
      setProviderAccessCode: (
        providerId: string,
        accessCode: string,
      ) => Promise<void>;
      findProviderByAccessCode: (
        accessCode: string,
      ) => Promise<
        { id: string; name: string; available: boolean } | undefined
      >;
      createProviderSession: (
        providerId: string,
        token: string,
      ) => Promise<void>;
      findProviderBySession: (
        token: string,
      ) => Promise<
        { id: string; name: string; available: boolean } | undefined
      >;
      findByProviderId: (
        providerId: string,
      ) => Promise<Array<{ id: string; assignedProvider?: { id: string } }>>;
      updateStatusForProvider: (
        requestId: string,
        providerId: string,
        status: 'on_the_way' | 'in_progress' | 'completed',
      ) => Promise<{ status: string }>;
      updateProviderAvailability: (
        providerId: string,
        available: boolean,
      ) => Promise<{ available: boolean }>;
    };
    expect(typeof providerStore.setProviderAccessCode).toBe('function');
    expect(typeof providerStore.findProviderByAccessCode).toBe('function');
    expect(typeof providerStore.createProviderSession).toBe('function');
    expect(typeof providerStore.findByProviderId).toBe('function');

    const accessCode = `provider-access-${randomUUID()}`;
    await providerStore.setProviderAccessCode('provider-1', accessCode);
    const provider = await providerStore.findProviderByAccessCode(accessCode);
    expect(provider).toMatchObject({ id: 'provider-1', available: true });

    await providerStore.createProviderSession('provider-1', 'provider-session');
    await expect(
      providerStore.findProviderBySession('provider-session'),
    ).resolves.toMatchObject({ id: 'provider-1' });

    const customer = await repository.upsertCustomer('+966****0681');
    const ownRequest = await repository.create(
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    await repository.assignProvider(ownRequest.id, 'provider-1');

    const otherRequest = await repository.create(
      {
        serviceId: 'plumbing',
        address: 'حي النهضة، بريدة',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    await repository.assignProvider(otherRequest.id, 'provider-3');

    const assignedRequests = await providerStore.findByProviderId('provider-1');
    expect(
      assignedRequests.some(
        (request) =>
          request.id === ownRequest.id &&
          request.assignedProvider?.id === 'provider-1',
      ),
    ).toBe(true);
    await expect(
      providerStore.updateStatusForProvider(
        ownRequest.id,
        'provider-1',
        'on_the_way',
      ),
    ).resolves.toMatchObject({ status: 'on_the_way' });
    await expect(
      providerStore.updateStatusForProvider(
        otherRequest.id,
        'provider-1',
        'on_the_way',
      ),
    ).rejects.toThrow('Assigned provider request not found');

    await expect(
      providerStore.updateProviderAvailability('provider-1', false),
    ).resolves.toMatchObject({ available: false });
    await providerStore.updateProviderAvailability('provider-1', true);
  });

  it('upgrades a legacy provider access-code hash after a successful login', async () => {
    const accessCode = `provider-access-${randomUUID()}`;
    const provider = await repository.createPilotProvider({
      name: 'مقدم خدمة ترحيل الرمز',
      specialties: ['ac-cleaning'],
      serviceZone: 'بريدة',
    });
    await repository.updatePilotProviderVerification(provider.id, 'verified');

    const pool = new Pool({
      connectionString: resolveDatabaseConnectionString(),
    });
    try {
      const legacyHash = createHash('sha256').update(accessCode).digest('hex');
      await pool.query(
        `INSERT INTO provider_access_credentials (provider_id, access_code_hash)
         VALUES ($1, $2)`,
        [provider.id, legacyHash],
      );
      // The idempotent schema backfill must run before lookup works.
      await repository.initialize();

      await expect(
        repository.findProviderByAccessCode(accessCode),
      ).resolves.toMatchObject({ id: provider.id });

      const stored = await pool.query<{ access_code_hash: string }>(
        'SELECT access_code_hash FROM provider_access_credentials WHERE provider_id = $1',
        [provider.id],
      );
      expect(stored.rows[0]?.access_code_hash).toMatch(/^scrypt\$/);
    } finally {
      await pool.end();
    }
  }, 15_000);

  it('keeps provider lookups indexed: an unknown code is not verified against every provider', async () => {
    const probe = new Pool({
      connectionString: resolveDatabaseConnectionString(),
    });
    try {
      expect(indexedProviderAccessCodeFixtures).toHaveLength(200);
      expect(
        new Set(
          indexedProviderAccessCodeFixtures.map(({ accessCode }) => accessCode),
        ).size,
      ).toBe(200);
      expect(
        new Set(
          indexedProviderAccessCodeFixtures.map(({ lookupId }) => lookupId),
        ).size,
      ).toBe(200);
      expect(
        new Set(
          indexedProviderAccessCodeFixtures.map(
            ({ accessCodeHash }) => accessCodeHash,
          ),
        ).size,
      ).toBe(200);
      expect(
        indexedProviderAccessCodeFixtures.every(
          ({ accessCode, lookupId, accessCodeHash }) =>
            lookupId === providerAccessCodeLookupId(accessCode) &&
            /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/i.test(accessCodeHash),
        ),
      ).toBe(true);

      for (const [
        index,
        fixture,
      ] of indexedProviderAccessCodeFixtures.entries()) {
        await probe.query(
          `INSERT INTO providers (id, name, specialties, available, service_zone, verification_status)
           VALUES ($1, $2, ARRAY['ac-cleaning'], TRUE, 'بريدة', 'verified')`,
          [fixture.providerId, `مقدم أداء ${index}`],
        );
        await probe.query(
          `INSERT INTO provider_access_credentials (provider_id, access_code_hash, lookup_id)
           VALUES ($1, $2, $3)`,
          [fixture.providerId, fixture.accessCodeHash, fixture.lookupId],
        );
      }
      const startedAt = Date.now();
      await expect(
        repository.findProviderByAccessCode(`unknown-code-${randomUUID()}`),
      ).resolves.toBeUndefined();
      const elapsedMs = Date.now() - startedAt;
      // New path: one indexed lookup + one dummy verification (~0.1s).
      // The old O(N) path would verify 200 scrypt hashes (~12s+).
      expect(elapsedMs).toBeLessThan(5000);
    } finally {
      await probe.end();
    }
  }, 30_000);

  it('backfills lookup ids for legacy SHA-256 credentials and keeps them authenticating', async () => {
    const provider = await createVerifiedProvider(['ac-cleaning']);
    const accessCode = `legacy-backfill-${randomUUID()}`;
    const legacyHash = createHash('sha256').update(accessCode).digest('hex');
    const probe = new Pool({
      connectionString: resolveDatabaseConnectionString(),
    });
    try {
      await probe.query(
        `INSERT INTO provider_access_credentials (provider_id, access_code_hash)
         VALUES ($1, $2)`,
        [provider.id, legacyHash],
      );
      await repository.initialize();
      const stored = await probe.query<{ lookup_id: string | null }>(
        'SELECT lookup_id FROM provider_access_credentials WHERE provider_id = $1',
        [provider.id],
      );
      expect(stored.rows[0]?.lookup_id).toBe(legacyHash);
      await expect(
        repository.findProviderByAccessCode(accessCode),
      ).resolves.toMatchObject({ id: provider.id });
    } finally {
      await probe.end();
    }
  });

  it('fails generically for a scrypt credential without lookup_id until the code is rotated', async () => {
    const provider = await createVerifiedProvider(['ac-cleaning']);
    const accessCode = `scrypt-no-lookup-${randomUUID()}`;
    const probe = new Pool({
      connectionString: resolveDatabaseConnectionString(),
    });
    try {
      await probe.query(
        `INSERT INTO provider_access_credentials (provider_id, access_code_hash)
         VALUES ($1, $2)`,
        [provider.id, await hashProviderAccessCode(accessCode)],
      );
      await expect(
        repository.findProviderByAccessCode(accessCode),
      ).resolves.toBeUndefined();
      await repository.setProviderAccessCode(provider.id, accessCode);
      await expect(
        repository.findProviderByAccessCode(accessCode),
      ).resolves.toMatchObject({ id: provider.id });
    } finally {
      await probe.end();
    }
  });

  it('rejects a duplicate provider access code with a controlled error', async () => {
    const providerA = await createVerifiedProvider(['ac-cleaning']);
    const providerB = await createVerifiedProvider(['ac-cleaning']);
    const accessCode = `shared-code-${randomUUID()}`;
    await repository.setProviderAccessCode(providerA.id, accessCode);
    await expect(
      repository.setProviderAccessCode(providerB.id, accessCode),
    ).rejects.toThrow('Provider access code is already in use');
  });

  it('keeps existing provider sessions valid after the lookup migration', async () => {
    const provider = await createVerifiedProvider(['ac-cleaning']);
    const accessCode = `session-migration-${randomUUID()}`;
    await repository.setProviderAccessCode(provider.id, accessCode);
    await repository.createProviderSession(
      provider.id,
      'session-token-after-migration',
    );
    await expect(
      repository.findProviderBySession('session-token-after-migration'),
    ).resolves.toMatchObject({ id: provider.id });
    await expect(
      repository.findProviderByAccessCode(accessCode),
    ).resolves.toMatchObject({ id: provider.id });
  });

  it('records an immutable creation event for a new customer request', async () => {
    const historyReader = repository as unknown as {
      findRequestEvents: (
        requestId: string,
      ) => Promise<Array<{ type: string; status: string; createdAt: string }>>;
    };
    expect(typeof historyReader.findRequestEvents).toBe('function');

    const customer = await repository.upsertCustomer('+966****3462');
    const request = await repository.create(
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );

    await expect(historyReader.findRequestEvents(request.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'request_created',
          status: 'pending_dispatch',
        }),
      ]),
    );
  });

  it('requires customer approval before a quoted job can enter service', async () => {
    const quoteStore = repository as unknown as {
      proposeQuote: (
        requestId: string,
        amountHalalas: number,
        scope: string,
      ) => Promise<{ id: string; status: string; amountHalalas: number }>;
      decideQuote: (
        requestId: string,
        customerId: string,
        quoteId: string,
        decision: 'approved' | 'rejected',
      ) => Promise<{ id: string; status: string }>;
    };
    expect(typeof quoteStore.proposeQuote).toBe('function');
    expect(typeof quoteStore.decideQuote).toBe('function');

    const customer = await repository.upsertCustomer('+966****3464');
    // A unique serviceId guarantees no provider (seeded or accumulated from
    // earlier runs) can match, so the request has no auto-created
    // opportunities and the legacy staff quote path applies.
    const uniqueServiceId = `staff-flow-${randomUUID()}`;
    const request = await repository.create(
      {
        serviceId: uniqueServiceId,
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    const staffProvider = await createVerifiedProvider([uniqueServiceId]);
    await repository.assignProvider(request.id, staffProvider.id);
    await repository.updateStatus(request.id, 'on_the_way');

    const quote = await quoteStore.proposeQuote(
      request.id,
      15_000,
      'إصلاح تسرب تحت المغسلة',
    );
    expect(quote).toMatchObject({ status: 'proposed', amountHalalas: 15_000 });
    await expect(
      repository.updateStatus(request.id, 'in_progress'),
    ).rejects.toThrow('Quote approval required');

    await expect(
      quoteStore.decideQuote(request.id, customer.id, quote.id, 'approved'),
    ).resolves.toMatchObject({ id: quote.id, status: 'approved' });
    await expect(
      repository.updateStatus(request.id, 'in_progress'),
    ).resolves.toMatchObject({
      status: 'in_progress',
    });
  });

  it('appends one lifecycle event for assignment and every valid status update', async () => {
    const customer = await repository.upsertCustomer('+966****3463');
    const request = await repository.create(
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );

    await repository.assignProvider(request.id, 'provider-1');
    await repository.updateStatus(request.id, 'on_the_way');
    await repository.updateStatus(request.id, 'in_progress');
    await repository.updateStatus(request.id, 'completed');

    await expect(repository.findRequestEvents(request.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'request_created',
          status: 'pending_dispatch',
        }),
        expect.objectContaining({
          type: 'provider_assigned',
          status: 'assigned',
        }),
        expect.objectContaining({
          type: 'status_updated',
          status: 'on_the_way',
        }),
        expect.objectContaining({
          type: 'status_updated',
          status: 'in_progress',
        }),
        expect.objectContaining({
          type: 'status_updated',
          status: 'completed',
        }),
      ]),
    );
  });

  it('does not allow a dispatched job to be assigned a second time', async () => {
    const customer = await repository.upsertCustomer('+966****3461');
    const request = await repository.create(
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    await repository.assignProvider(request.id, 'provider-1');

    await expect(
      repository.assignProvider(request.id, 'provider-1'),
    ).rejects.toThrow('Request or available provider not found');
  });

  it('prevents a dispatcher from completing an assigned job before service starts', async () => {
    const customer = await repository.upsertCustomer('+966****3460');
    const request = await repository.create(
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    await repository.assignProvider(request.id, 'provider-1');

    await expect(
      repository.updateStatus(request.id, 'completed'),
    ).rejects.toThrow('Invalid status transition');
  });

  it('creates a cash-due payment for an approved quote and collects it only after completion', async () => {
    const paymentStore = repository as unknown as {
      collectCashPayment: (requestId: string) => Promise<{
        method: string;
        status: string;
        amountHalalas: number;
      }>;
    };
    const customer = await repository.upsertCustomer(
      `cash-test-${randomUUID()}`,
    );
    // A unique serviceId guarantees no provider can match, so the request
    // has no auto-created opportunities and the staff quote path applies.
    const uniqueServiceId = `staff-cash-${randomUUID()}`;
    const request = await repository.create(
      {
        serviceId: uniqueServiceId,
        address: 'حي الصفراء، بريدة',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    const staffProvider = await createVerifiedProvider([uniqueServiceId]);
    await repository.assignProvider(request.id, staffProvider.id);
    await repository.updateStatus(request.id, 'on_the_way');
    const quote = await repository.proposeQuote(
      request.id,
      15_000,
      'إصلاح تسرب تحت المغسلة',
    );
    await repository.decideQuote(request.id, customer.id, quote.id, 'approved');

    const payment = (
      (await repository.findByCustomerId(customer.id)).find(
        (item) => item.id === request.id,
      ) as typeof request & {
        payment?: { method: string; status: string; amountHalalas: number };
      }
    ).payment;
    expect(payment).toMatchObject({
      method: 'cash_on_completion',
      status: 'cash_due',
      amountHalalas: 15_000,
    });
    await expect(paymentStore.collectCashPayment(request.id)).rejects.toThrow(
      'Cash can only be collected after completion',
    );

    await repository.updateStatus(request.id, 'in_progress');
    await repository.updateStatus(request.id, 'completed');
    await expect(paymentStore.collectCashPayment(request.id)).resolves.toEqual(
      expect.objectContaining({
        method: 'cash_on_completion',
        status: 'cash_collected',
        amountHalalas: 15_000,
      }),
    );
  });

  it('persists a request under the owning customer and returns it only for that customer', async () => {
    const customer = await repository.upsertCustomer('+966****0111');
    const created = await repository.create(
      {
        serviceId: 'upholstery',
        address: 'حي النهضة، بريدة',
        details: 'غسيل كنب',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );

    const requests = await repository.findByCustomerId(customer.id);

    expect(created.id).toMatch(/^MOE-\d+$/);
    expect(created).toMatchObject({
      serviceId: 'upholstery',
      status: 'pending_dispatch',
    });
    expect(requests).toContainEqual({ ...created, quotes: [] });
  });

  async function createVerifiedProvider(specialties: string[]) {
    const provider = await repository.createPilotProvider({
      name: `مقدم اختبار ${randomUUID().slice(0, 8)}`,
      specialties,
      serviceZone: 'بريدة',
    });
    return repository.updatePilotProviderVerification(provider.id, 'verified');
  }

  async function createPendingRequest(serviceId = 'ac-cleaning') {
    const customer = await repository.upsertCustomer(
      `+9665${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`,
    );
    const request = await repository.create(
      {
        serviceId,
        address: 'حي الصفراء، بريدة',
        details: 'تفاصيل حساسة للخصوصية',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    return { request, customerId: customer.id };
  }

  async function readEventTypes(requestId: string): Promise<string[]> {
    const probe = new Pool({
      connectionString: resolveDatabaseConnectionString(),
    });
    try {
      const result = await probe.query<{ type: string }>(
        `SELECT type FROM service_request_events
         WHERE service_request_id = $1 ORDER BY id`,
        [Number(requestId.replace('MOE-', '')) - 1000],
      );
      return result.rows.map((row) => row.type);
    } finally {
      await probe.end();
    }
  }

  it('invites only eligible providers and records opportunity events', async () => {
    // Request is created first so the providers below do not exist at
    // auto-invite time; the manual invitation path then exercises its own
    // eligibility filtering.
    const { request } = await createPendingRequest('ac-cleaning');
    const eligible = await createVerifiedProvider(['ac-cleaning']);
    const pending = await repository.createPilotProvider({
      name: `مقدم معلق ${randomUUID().slice(0, 8)}`,
      specialties: ['ac-cleaning'],
      serviceZone: 'بريدة',
    });
    const suspended = await repository.updatePilotProviderVerification(
      (await createVerifiedProvider(['ac-cleaning'])).id,
      'suspended',
    );
    const wrongSpecialty = await createVerifiedProvider(['plumbing']);

    const created = await repository.inviteProvidersToRequest(request.id, [
      eligible.id,
      pending.id,
      suspended.id,
      wrongSpecialty.id,
    ]);

    expect(created.map((opportunity) => opportunity.requestId)).toEqual([
      request.id,
    ]);
    expect(created[0]).toMatchObject({
      serviceId: 'ac-cleaning',
      opportunityStatus: 'invited',
    });
    expect(await readEventTypes(request.id)).toContain('opportunity_invited');
    const opportunities = await repository.listProviderOpportunities(
      eligible.id,
    );
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].requestId).toBe(request.id);
    await expect(
      repository.listProviderOpportunities(wrongSpecialty.id),
    ).resolves.toEqual([]);
  });

  it('automatically invites only eligible providers on request creation, emitting an event per inserted row only', async () => {
    const eligible = await createVerifiedProvider(['ac-cleaning']);
    const unavailable = await repository.updateProviderAvailability(
      (await createVerifiedProvider(['ac-cleaning'])).id,
      false,
    );
    const wrongSpecialty = await createVerifiedProvider(['plumbing']);
    const customer = await repository.upsertCustomer(
      `+9665${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`,
    );

    const created = await repository.create(
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        details: 'تفاصيل حساسة للخصوصية',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );

    expect(created.status).toBe('pending_dispatch');
    const eligibleOpportunities = await repository.listProviderOpportunities(
      eligible.id,
    );
    expect(eligibleOpportunities).toHaveLength(1);
    expect(eligibleOpportunities[0]).toMatchObject({
      requestId: created.id,
      serviceId: 'ac-cleaning',
      opportunityStatus: 'invited',
    });
    // Ineligible providers (unavailable, wrong specialty) get no opportunity.
    await expect(
      repository.listProviderOpportunities(unavailable.id),
    ).resolves.toEqual([]);
    await expect(
      repository.listProviderOpportunities(wrongSpecialty.id),
    ).resolves.toEqual([]);

    // Events: the request_created event plus one opportunity_invited per
    // provider actually eligible at creation time. The test DB accumulates
    // providers across runs, so assert relatively: the eligible provider's
    // row produced an invitation event, and ineligible providers produced
    // none attributable to them (their opportunity lists are empty).
    const events = await repository.findRequestEvents(created.id);
    expect(
      events.some(
        (event) =>
          event.type === 'opportunity_invited' &&
          event.status === 'pending_dispatch',
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === 'request_created')).toBe(true);
  });

  it('does not duplicate opportunities or invitation events when a row already exists', async () => {
    const provider = await createVerifiedProvider(['ac-cleaning']);
    const customer = await repository.upsertCustomer(
      `+9665${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`,
    );

    // First creation auto-invites the eligible provider.
    const first = await repository.create(
      {
        serviceId: 'ac-cleaning',
        address: 'حي الصفراء، بريدة',
        details: 'تفاصيل حساسة للخصوصية',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    const before = await repository.listProviderOpportunities(provider.id);
    expect(before).toHaveLength(1);
    const beforeCount = (await repository.findRequestEvents(first.id)).filter(
      (event) => event.type === 'opportunity_invited',
    ).length;

    // Manual invitation of the same provider is a no-op conflict: no second
    // opportunity row and no second invitation event.
    const manual = await repository.inviteProvidersToRequest(first.id, [
      provider.id,
    ]);
    expect(manual).toEqual([]);
    const after = await repository.listProviderOpportunities(provider.id);
    expect(after).toHaveLength(1);
    const afterCount = (await repository.findRequestEvents(first.id)).filter(
      (event) => event.type === 'opportunity_invited',
    ).length;
    expect(afterCount).toBe(beforeCount);
  });

  it('creates the request without opportunities or invitation events when no provider is eligible', async () => {
    // A unique serviceId guarantees no provider (seeded or accumulated from
    // earlier runs) can match it, keeping this test deterministic.
    const uniqueServiceId = `unmatched-${randomUUID()}`;
    const customer = await repository.upsertCustomer(
      `+9665${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`,
    );
    const created = await repository.create(
      {
        serviceId: uniqueServiceId,
        address: 'حي الصفراء، بريدة',
        details: 'تفاصيل حساسة للخصوصية',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );

    expect(created.status).toBe('pending_dispatch');
    const events = await repository.findRequestEvents(created.id);
    expect(
      events.filter((event) => event.type === 'opportunity_invited'),
    ).toHaveLength(0);
    expect(events.map((event) => event.type)).toContain('request_created');
  });

  it('rejects invitations when an active quote exists, on completed requests, and for empty lists', async () => {
    // A unique serviceId guarantees no provider can match, so the request
    // has no auto-created opportunities; the staff quote path then applies
    // and the "active quote blocks invitations" rule is exercised. The
    // provider is created after the request so auto-invite cannot reach it.
    const activeQuoteServiceId = `staff-invite-${randomUUID()}`;
    const quoteRequest = await createPendingRequest(activeQuoteServiceId);
    const staffProvider = await createVerifiedProvider([activeQuoteServiceId]);
    await repository.assignProvider(quoteRequest.request.id, staffProvider.id);
    await repository.proposeQuote(
      quoteRequest.request.id,
      10_000,
      'فحص وتنظيف',
    );
    await expect(
      repository.inviteProvidersToRequest(quoteRequest.request.id, [
        staffProvider.id,
      ]),
    ).rejects.toThrow(
      'An active quote exists; provider invitations are not allowed',
    );

    const completedServiceId = `staff-completed-${randomUUID()}`;
    const completed = await createPendingRequest(completedServiceId);
    const mover = await createVerifiedProvider([completedServiceId]);
    await repository.assignProvider(completed.request.id, mover.id);
    await repository.updateStatus(completed.request.id, 'on_the_way');
    await repository.updateStatus(completed.request.id, 'in_progress');
    await repository.updateStatus(completed.request.id, 'completed');
    await expect(
      repository.inviteProvidersToRequest(completed.request.id, [mover.id]),
    ).rejects.toThrow('Request is not open for provider invitations');

    await expect(
      repository.inviteProvidersToRequest(completed.request.id, []),
    ).rejects.toThrow('Provider invitation list is empty');
  });

  it('rejects staff quote proposals while provider opportunities exist', async () => {
    const provider = await createVerifiedProvider(['ac-cleaning']);
    const { request } = await createPendingRequest('ac-cleaning');
    await repository.assignProvider(request.id, provider.id);
    await repository.inviteProvidersToRequest(request.id, [provider.id]);

    await expect(
      repository.proposeQuote(request.id, 12_000, 'عرض من الموظف'),
    ).rejects.toThrow(
      'Request is in the marketplace quote flow; staff quotes are not allowed',
    );
  });

  it('lets a provider submit one quote per opportunity and rejects a duplicate with a domain error', async () => {
    const provider = await createVerifiedProvider(['ac-cleaning']);
    const { request } = await createPendingRequest('ac-cleaning');
    await repository.inviteProvidersToRequest(request.id, [provider.id]);

    const quote = await repository.submitProviderQuote(
      request.id,
      provider.id,
      15_000,
      'تنظيف شامل للمكيفات',
    );
    expect(quote).toMatchObject({
      providerId: provider.id,
      amountHalalas: 15_000,
      status: 'proposed',
    });
    const opportunities = await repository.listProviderOpportunities(
      provider.id,
    );
    expect(opportunities[0].opportunityStatus).toBe('quoted');
    expect(opportunities[0].myQuote?.id).toBe(quote.id);

    await expect(
      repository.submitProviderQuote(
        request.id,
        provider.id,
        9_000,
        'عرض أرخص',
      ),
    ).rejects.toThrow('You already have an active quote for this request');
  });

  it('allows two different providers to each hold an active quote for the same request', async () => {
    const providerA = await createVerifiedProvider(['ac-cleaning']);
    const providerB = await createVerifiedProvider(['ac-cleaning']);
    const { request } = await createPendingRequest('ac-cleaning');
    await repository.inviteProvidersToRequest(request.id, [
      providerA.id,
      providerB.id,
    ]);
    await repository.submitProviderQuote(
      request.id,
      providerA.id,
      15_000,
      'عرض المكيف',
    );
    await repository.submitProviderQuote(
      request.id,
      providerB.id,
      12_000,
      'عرض منافس',
    );
    const viewA = await repository.listProviderOpportunities(providerA.id);
    const viewB = await repository.listProviderOpportunities(providerB.id);
    expect(viewA[0].myQuote?.amountHalalas).toBe(15_000);
    expect(viewB[0].myQuote?.amountHalalas).toBe(12_000);
  });

  it('rejects provider quotes when the request is not pending dispatch, without an opportunity, or while a staff quote is active', async () => {
    const provider = await createVerifiedProvider(['ac-cleaning']);
    const assignedRequest = await createPendingRequest('ac-cleaning');
    await repository.inviteProvidersToRequest(assignedRequest.request.id, [
      provider.id,
    ]);
    await repository.assignProvider(assignedRequest.request.id, provider.id);
    await expect(
      repository.submitProviderQuote(
        assignedRequest.request.id,
        provider.id,
        10_000,
        'عرض',
      ),
    ).rejects.toThrow(
      'Provider quotes are only accepted while the request is pending dispatch',
    );

    // The stranger is created after the request so auto-invite cannot reach
    // it; without an opportunity row, quoting is rejected.
    const { request } = await createPendingRequest('ac-cleaning');
    const stranger = await createVerifiedProvider(['ac-cleaning']);
    await expect(
      repository.submitProviderQuote(request.id, stranger.id, 10_000, 'عرض'),
    ).rejects.toThrow('Provider opportunity is not open for quoting');

    // A fresh provider (created after the request) is not auto-invited, so
    // the probe can insert its opportunity row without a unique conflict.
    const staffRequest = await createPendingRequest('ac-cleaning');
    const staffSectionProvider = await createVerifiedProvider(['ac-cleaning']);
    const probe = new Pool({
      connectionString: resolveDatabaseConnectionString(),
    });
    try {
      const requestDatabaseId =
        Number(staffRequest.request.id.replace('MOE-', '')) - 1000;
      await probe.query(
        `INSERT INTO request_provider_opportunities (service_request_id, provider_id)
         VALUES ($1, $2)`,
        [requestDatabaseId, staffSectionProvider.id],
      );
      await probe.query(
        `INSERT INTO service_quotes (service_request_id, amount_halalas, scope, status)
         VALUES ($1, 9999, 'عرض موظف مباشر', 'proposed')`,
        [requestDatabaseId],
      );
    } finally {
      await probe.end();
    }
    await expect(
      repository.submitProviderQuote(
        staffRequest.request.id,
        staffSectionProvider.id,
        10_000,
        'عرض مقدم',
      ),
    ).rejects.toThrow(
      'Request is in the marketplace quote flow; staff quotes are not allowed',
    );
  });

  it('lets a provider withdraw only their own proposed quote', async () => {
    const providerA = await createVerifiedProvider(['ac-cleaning']);
    const providerB = await createVerifiedProvider(['ac-cleaning']);
    const { request } = await createPendingRequest('ac-cleaning');
    await repository.inviteProvidersToRequest(request.id, [
      providerA.id,
      providerB.id,
    ]);
    const quoteA = await repository.submitProviderQuote(
      request.id,
      providerA.id,
      15_000,
      'عرض أ',
    );
    await repository.submitProviderQuote(
      request.id,
      providerB.id,
      12_000,
      'عرض ب',
    );

    await expect(
      repository.withdrawProviderQuote(quoteA.id, providerB.id),
    ).rejects.toThrow('Pending provider quote not found');

    const withdrawn = await repository.withdrawProviderQuote(
      quoteA.id,
      providerA.id,
    );
    expect(withdrawn.status).toBe('withdrawn');
    const opportunities = await repository.listProviderOpportunities(
      providerA.id,
    );
    expect(opportunities[0].opportunityStatus).toBe('withdrawn');
    expect(opportunities[0].myQuote?.status).toBe('withdrawn');

    await expect(
      repository.withdrawProviderQuote(quoteA.id, providerA.id),
    ).rejects.toThrow('Pending provider quote not found');
  });

  it('approving a provider quote atomically closes competitors and opportunities, assigns the winner, and moves the request to assigned', async () => {
    const winner = await createVerifiedProvider(['ac-cleaning']);
    const loser = await createVerifiedProvider(['ac-cleaning']);
    const { request, customerId } = await createPendingRequest('ac-cleaning');
    await repository.inviteProvidersToRequest(request.id, [
      winner.id,
      loser.id,
    ]);
    const winnerQuote = await repository.submitProviderQuote(
      request.id,
      winner.id,
      15_000,
      'عرض الفائز',
    );
    const loserQuote = await repository.submitProviderQuote(
      request.id,
      loser.id,
      12_000,
      'عرض الخاسر',
    );

    const approved = await repository.decideQuote(
      request.id,
      customerId,
      winnerQuote.id,
      'approved',
    );
    expect(approved).toMatchObject({
      id: winnerQuote.id,
      providerId: winner.id,
      status: 'approved',
    });

    const customerView = await repository.findByCustomerId(customerId);
    const updated = customerView.find((item) => item.id === request.id);
    expect(updated?.status).toBe('assigned');
    expect(updated?.assignedProvider?.id).toBe(winner.id);
    expect(updated?.payment).toMatchObject({
      method: 'cash_on_completion',
      status: 'cash_due',
      amountHalalas: 15_000,
    });

    const loserView = await repository.listProviderOpportunities(loser.id);
    expect(loserView[0].opportunityStatus).toBe('closed');
    expect(loserView[0].myQuote?.id).toBe(loserQuote.id);
    expect(loserView[0].myQuote?.status).toBe('rejected');

    const events = await readEventTypes(request.id);
    expect(events).toContain('quote_approved');
    expect(events).toContain('quote_rejected');
    expect(events).toContain('opportunity_closed');
    expect(events).toContain('provider_assigned');
  });

  it('approval fails safely when the winning provider is not available or verified, with no state changes', async () => {
    for (const degradedStatus of ['suspended', 'pending'] as const) {
      const provider = await createVerifiedProvider(['ac-cleaning']);
      const { request, customerId } = await createPendingRequest('ac-cleaning');
      await repository.inviteProvidersToRequest(request.id, [provider.id]);
      const quote = await repository.submitProviderQuote(
        request.id,
        provider.id,
        15_000,
        'عرض',
      );
      await repository.updatePilotProviderVerification(
        provider.id,
        degradedStatus,
      );

      await expect(
        repository.decideQuote(request.id, customerId, quote.id, 'approved'),
      ).rejects.toThrow(
        'The selected provider is not available; choose another quote',
      );

      const opportunities = await repository.listProviderOpportunities(
        provider.id,
      );
      expect(opportunities[0].opportunityStatus).toBe('quoted');
      expect(opportunities[0].myQuote?.status).toBe('proposed');
      const customerView = await repository.findByCustomerId(customerId);
      const requestView = customerView.find((item) => item.id === request.id);
      expect(requestView?.status).toBe('pending_dispatch');
      expect(requestView?.assignedProvider).toBeUndefined();
      expect(requestView?.payment).toBeUndefined();
      const events = await readEventTypes(request.id);
      expect(events).not.toContain('quote_approved');
      expect(events).not.toContain('provider_assigned');
    }
  });

  it('concurrent approvals of two provider quotes select exactly one winner', async () => {
    const providerA = await createVerifiedProvider(['ac-cleaning']);
    const providerB = await createVerifiedProvider(['ac-cleaning']);
    const { request, customerId } = await createPendingRequest('ac-cleaning');
    await repository.inviteProvidersToRequest(request.id, [
      providerA.id,
      providerB.id,
    ]);
    const quoteA = await repository.submitProviderQuote(
      request.id,
      providerA.id,
      15_000,
      'عرض أ',
    );
    const quoteB = await repository.submitProviderQuote(
      request.id,
      providerB.id,
      12_000,
      'عرض ب',
    );

    const results = await Promise.allSettled([
      repository.decideQuote(request.id, customerId, quoteA.id, 'approved'),
      repository.decideQuote(request.id, customerId, quoteB.id, 'approved'),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);

    const customerView = await repository.findByCustomerId(customerId);
    const requestView = customerView.find((item) => item.id === request.id);
    const winnerId = requestView?.assignedProvider?.id;
    expect([providerA.id, providerB.id]).toContain(winnerId);
    const viewA = await repository.listProviderOpportunities(providerA.id);
    const viewB = await repository.listProviderOpportunities(providerB.id);
    const winnerView = winnerId === providerA.id ? viewA[0] : viewB[0];
    const loserView = winnerId === providerA.id ? viewB[0] : viewA[0];
    expect(winnerView.myQuote?.status).toBe('approved');
    expect(loserView.myQuote?.status).toBe('rejected');
  });

  it('keeps existing staff quote records and old event rows valid after the constraint extensions', async () => {
    // A unique serviceId guarantees no provider can match, so the request
    // has no auto-created opportunities and the staff quote path applies.
    // The provider is created after the request so auto-invite cannot
    // reach it.
    const uniqueServiceId = `staff-legacy-${randomUUID()}`;
    const { request, customerId } = await createPendingRequest(uniqueServiceId);
    const provider = await createVerifiedProvider([uniqueServiceId]);
    await repository.assignProvider(request.id, provider.id);
    const staffQuote = await repository.proposeQuote(
      request.id,
      10_000,
      'عرض الموظف القديم',
    );
    const approved = await repository.decideQuote(
      request.id,
      customerId,
      staffQuote.id,
      'approved',
    );
    expect(approved.status).toBe('approved');
    const customerView = await repository.findByCustomerId(customerId);
    expect(
      customerView.find((item) => item.id === request.id)?.payment,
    ).toMatchObject({ status: 'cash_due' });

    const probe = new Pool({
      connectionString: resolveDatabaseConnectionString(),
    });
    try {
      const requestDatabaseId = Number(request.id.replace('MOE-', '')) - 1000;
      await probe.query(
        `INSERT INTO service_quotes (service_request_id, amount_halalas, scope, status)
         VALUES ($1, 5000, 'عرض قديم مرفوض', 'rejected')`,
        [requestDatabaseId],
      );
      await probe.query(
        `INSERT INTO service_request_events (service_request_id, type, status)
         VALUES ($1, 'quote_proposed', 'assigned')`,
        [requestDatabaseId],
      );
    } finally {
      await probe.end();
    }
    expect(await readEventTypes(request.id)).toContain('quote_proposed');
  });

  it('never exposes address, details, or customer data through provider opportunities', async () => {
    const provider = await createVerifiedProvider(['ac-cleaning']);
    const customer = await repository.upsertCustomer(
      `+9665${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`,
    );
    const request = await repository.create(
      {
        serviceId: 'ac-cleaning',
        address: 'شارع الأمير سلطان، حي الصفراء، بريدة — منزل خاص',
        details: 'معلومات حساسة جدًا مع رقم جوال في الملاحظات',
        timing: 'as-soon-as-possible',
      },
      customer.id,
    );
    await repository.inviteProvidersToRequest(request.id, [provider.id]);

    const opportunities = await repository.listProviderOpportunities(
      provider.id,
    );
    expect(opportunities).toHaveLength(1);
    const opportunity = opportunities[0];
    expect(Object.keys(opportunity).sort()).toEqual([
      'myQuote',
      'opportunityStatus',
      'requestId',
      'serviceId',
      'timing',
    ]);
    const serialized = JSON.stringify(opportunity);
    expect(serialized).not.toContain('شارع الأمير سلطان');
    expect(serialized).not.toContain('معلومات حساسة');
  });

  describe('migration CHECK scoping across all four constraints (Q0-SEC regression)', () => {
    // Table-driven, self-contained, parallel-safe: for each of the four
    // migrations the test builds TWO per-invocation schemas (subject +
    // sibling) with Q0-SEC ownership markers. The live run schema's tables
    // and constraints are never touched — no downgrade, no delete, no DROP.
    const runId = process.env.MOEEN_TEST_RUN_ID as string;

    const CASES = [
      {
        table: 'service_quotes',
        constraint: 'service_quotes_status_check',
        column: 'status',
        repository: 'serviceRequest' as const,
        required: ['proposed', 'approved', 'rejected', 'withdrawn'],
        partial: "CHECK (status IN ('proposed', 'approved', 'rejected'))",
        full: "CHECK (status IN ('proposed', 'approved', 'rejected', 'withdrawn'))",
      },
      {
        // The partial constraint already contains opportunity_closed but is
        // missing opportunity_invited, provider_quote_submitted and
        // provider_quote_withdrawn — it must still be repaired (a
        // single-token LIKE guard would skip it).
        table: 'service_request_events',
        constraint: 'service_request_events_type_check',
        column: 'type',
        repository: 'serviceRequest' as const,
        required: [
          'request_created',
          'provider_assigned',
          'status_updated',
          'quote_proposed',
          'quote_approved',
          'quote_rejected',
          'opportunity_invited',
          'opportunity_closed',
          'provider_quote_submitted',
          'provider_quote_withdrawn',
        ],
        partial:
          "CHECK (type IN ('request_created', 'provider_assigned', 'status_updated', 'quote_proposed', 'quote_approved', 'quote_rejected', 'opportunity_closed'))",
        full: "CHECK (type IN ('request_created', 'provider_assigned', 'status_updated', 'quote_proposed', 'quote_approved', 'quote_rejected', 'opportunity_invited', 'opportunity_closed', 'provider_quote_submitted', 'provider_quote_withdrawn'))",
      },
      {
        table: 'request_provider_opportunities',
        constraint: 'request_provider_opportunities_status_check',
        column: 'status',
        repository: 'serviceRequest' as const,
        required: ['invited', 'quoted', 'withdrawn', 'closed', 'rejected'],
        partial:
          "CHECK (status IN ('invited', 'quoted', 'withdrawn', 'closed'))",
        full: "CHECK (status IN ('invited', 'quoted', 'withdrawn', 'closed', 'rejected'))",
      },
      {
        table: 'public_auth_rate_limits',
        constraint: 'public_auth_rate_limits_scope_check',
        column: 'scope',
        repository: 'staffAuth' as const,
        required: [
          'customer_otp_request',
          'customer_otp_verification',
          'provider_login',
        ],
        partial:
          "CHECK (scope IN ('customer_otp_request', 'customer_otp_verification'))",
        full: "CHECK (scope IN ('customer_otp_request', 'customer_otp_verification', 'provider_login'))",
      },
    ];

    // Q0-SEC ownership lifecycle: CREATE SCHEMA without IF NOT EXISTS, a
    // verifiable marker inside the schema, and no DROP before the marker is
    // proven to match this invocation's owner token.
    async function createOwnedSchema(
      pool: Pool,
      schema: string,
      tokenHash: string,
    ): Promise<void> {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await pool.query(
        `CREATE TABLE "${schema}".q0sec_run_ownership (
           run_id TEXT NOT NULL,
           owner_token_hash TEXT NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
      );
      await pool.query(
        `INSERT INTO "${schema}".q0sec_run_ownership (run_id, owner_token_hash)
         VALUES ($1, $2)`,
        [runId, tokenHash],
      );
    }

    async function dropOwnedSchema(
      pool: Pool,
      schema: string,
      tokenHash: string,
    ): Promise<void> {
      const marker = await pool.query<{
        run_id: string;
        owner_token_hash: string;
      }>(
        `SELECT run_id, owner_token_hash FROM "${schema}".q0sec_run_ownership`,
      );
      if (
        marker.rows.length !== 1 ||
        marker.rows[0].run_id !== runId ||
        marker.rows[0].owner_token_hash !== tokenHash
      ) {
        throw new Error(
          `Q0-SEC ownership: refusing to drop schema '${schema}' — marker missing or mismatch.`,
        );
      }
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    }

    // A repository instance bound to an explicit schema via its own
    // connection string. The repositories read TEST_DATABASE_URL at
    // construction time only, so the env is re-pointed synchronously for the
    // `new` call and restored immediately — single-threaded JS means nothing
    // else in the process can observe the change and no global state is left
    // behind (the guard never runs against these URLs; they are derived from
    // the already-guarded run URL).
    function repositoryFor<T extends { close(): Promise<void> }>(
      Ctor: new () => T,
      schema: string,
    ): T {
      const originalUrl = process.env.TEST_DATABASE_URL;
      const base = resolveDatabaseConnectionString().split('?')[0];
      process.env.TEST_DATABASE_URL = `${base}?options=${encodeURIComponent(`-c search_path=${schema}`)}`;
      const instance = new Ctor();
      process.env.TEST_DATABASE_URL = originalUrl;
      return instance;
    }

    async function withPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
      const pool = new Pool({
        connectionString: resolveDatabaseConnectionString(),
      });
      try {
        return await fn(pool);
      } finally {
        await pool.end();
      }
    }

    async function constraintDef(
      pool: Pool,
      schema: string,
      table: string,
      constraint: string,
    ): Promise<string | null> {
      const res = await pool.query<{ def: string }>(
        `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         WHERE c.conrelid = to_regclass(format('%I.%I', $1::text, $2::text))
           AND c.conname = $3::text`,
        [schema, table, constraint],
      );
      return res.rows[0]?.def ?? null;
    }

    for (const c of CASES) {
      it(`repairs ${c.constraint} in the subject schema while the sibling stays untouched (${c.table})`, async () => {
        // Per-invocation unique names: run id + random suffix, identifier
        // charset [a-z0-9_], well within PostgreSQL's 63-byte limit, so
        // parallel copies of this suite can never collide.
        const subject = `moeen_test_${runId}_x${randomBytes(3).toString('hex')}`;
        const sibling = `moeen_test_${runId}_y${randomBytes(3).toString('hex')}`;
        expect(subject).toMatch(/^[a-z0-9_]{4,63}$/);
        expect(sibling).toMatch(/^[a-z0-9_]{4,63}$/);
        expect(subject).not.toBe(sibling);

        const ownerToken = generateOwnerToken();
        const tokenHash = ownerTokenHash(ownerToken);
        const adminPool = new Pool({
          connectionString: resolveDatabaseConnectionString(),
        });
        const subjectRepo = repositoryFor(ServiceRequestRepository, subject);
        const subjectStaff = repositoryFor(StaffAuthRepository, subject);
        const siblingRepo = repositoryFor(ServiceRequestRepository, sibling);
        const siblingStaff = repositoryFor(StaffAuthRepository, sibling);
        try {
          await createOwnedSchema(adminPool, subject, tokenHash);
          await createOwnedSchema(adminPool, sibling, tokenHash);

          // Full independent baseline in BOTH schemas.
          await subjectRepo.initialize();
          await subjectStaff.initialize();
          await siblingRepo.initialize();
          await siblingStaff.initialize();

          // Explicit empty check on the target table before any downgrade —
          // never rely on test order or prior suite state.
          const rows = await adminPool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM "${subject}".${c.table}`,
          );
          expect(rows.rows[0].n).toBe(0);

          // Sibling's full definition, captured BEFORE the repair.
          const siblingDefBefore = await constraintDef(
            adminPool,
            sibling,
            c.table,
            c.constraint,
          );
          expect(siblingDefBefore).not.toBeNull();

          // Downgrade ONLY the subject's target constraint to the legacy
          // partial definition.
          await adminPool.query(
            `ALTER TABLE "${subject}".${c.table}
               DROP CONSTRAINT IF EXISTS ${c.constraint},
               ADD CONSTRAINT ${c.constraint} ${c.partial}`,
          );
          const downgraded = await constraintDef(
            adminPool,
            subject,
            c.table,
            c.constraint,
          );
          expect(downgraded).not.toBeNull();
          expect(c.required.every((value) => downgraded!.includes(value))).toBe(
            false,
          );

          // The OTHER three constraints in subject, captured after the
          // downgrade (they must stay untouched by the repair).
          const othersBefore = new Map<string, string | null>();
          for (const other of CASES) {
            if (other.constraint === c.constraint) continue;
            othersBefore.set(
              other.constraint,
              await constraintDef(
                adminPool,
                subject,
                other.table,
                other.constraint,
              ),
            );
          }

          // Repair: initialize() on the SUBJECT only (explicit search_path
          // connection, no global env change).
          await subjectRepo.initialize();
          await subjectStaff.initialize();

          // Subject's target constraint is complete again — every required
          // value present, and the definition matches the sibling's full
          // normalized definition exactly (not merely "exists by name").
          const subjectAfter = await constraintDef(
            adminPool,
            subject,
            c.table,
            c.constraint,
          );
          expect(subjectAfter).not.toBeNull();
          for (const value of c.required) {
            expect(subjectAfter).toContain(value);
          }
          expect(subjectAfter).toBe(siblingDefBefore);

          // No cross-schema modification: the sibling's same-named
          // constraint is literally unchanged...
          expect(
            await constraintDef(adminPool, sibling, c.table, c.constraint),
          ).toBe(siblingDefBefore);

          // ...and the other three constraints in subject are unchanged.
          for (const other of CASES) {
            if (other.constraint === c.constraint) continue;
            expect(
              await constraintDef(
                adminPool,
                subject,
                other.table,
                other.constraint,
              ),
            ).toBe(othersBefore.get(other.constraint));
          }
        } finally {
          // Ownership-verified cleanup — always, even on failure.
          try {
            await dropOwnedSchema(adminPool, subject, tokenHash);
            await dropOwnedSchema(adminPool, sibling, tokenHash);
          } finally {
            await adminPool.end();
            await subjectRepo.close();
            await subjectStaff.close();
            await siblingRepo.close();
            await siblingStaff.close();
          }
        }
      });
    }

    it('survives concurrent catalog create/drop cycles in unique schemas (stress)', async () => {
      const cycles = 6;
      const names = Array.from(
        { length: cycles },
        (_, i) => `moeen_test_${runId}_s${i}_${randomBytes(3).toString('hex')}`,
      );
      await withPool(async (pool) => {
        await Promise.all(
          names.map(async (name) => {
            await pool.query(`CREATE SCHEMA "${name}"`);
            await pool.query(
              `CREATE TABLE "${name}".t (
                 id INT PRIMARY KEY,
                 status TEXT NOT NULL
                   CHECK (status IN ('a', 'b', 'c'))
               )`,
            );
            await pool.query(
              `ALTER TABLE "${name}".t
                 DROP CONSTRAINT IF EXISTS t_status_check,
                 ADD CONSTRAINT t_status_check
                   CHECK (status IN ('a', 'b', 'c', 'd'))`,
            );
            await pool.query(`DROP SCHEMA "${name}" CASCADE`);
          }),
        );
        const leftover = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM information_schema.schemata
           WHERE schema_name = ANY($1)`,
          [names],
        );
        expect(leftover.rows[0].n).toBe(0);
      });
    });
  });
});
